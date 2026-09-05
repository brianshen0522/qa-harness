import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  DescriptionSource, Prisma, ProposalStatus, Role, Scope, TargetKind,
} from "@prisma/client";
import type { DiscussionTurn } from "@qa-harness/schemas";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionsService } from "../permissions/permissions.service";
import { LlmGatewayService } from "../llm/llm-gateway.service";
import { AuditService } from "../audit/audit.service";
import { ProjectsService } from "../projects/projects.service";
import { TargetsService } from "../targets/targets.service";
import type { LlmMessage } from "../llm/providers";
import {
  checklistFor, initialCompleteness, mergeCompleteness,
  type ChecklistItem, type CompletenessMap,
} from "./checklists";
import { extractUrls, UrlFetchService, type FetchedPage } from "./url-fetch.service";

/** How many past messages are replayed to the model. */
const HISTORY_LIMIT = 30;

export interface DiscussionTarget {
  scope: Scope;
  projectId: string;
  targetId?: string;
  kind?: TargetKind;
  entityName: string;
  description: string;
}

@Injectable()
export class DiscussionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionsService,
    private readonly gateway: LlmGatewayService,
    private readonly urls: UrlFetchService,
    private readonly projects: ProjectsService,
    private readonly targets: TargetsService,
    private readonly audit: AuditService,
  ) {}

  // ---------- resolution & access ----------

  private async resolveProject(projectId: string, userId: string, required: Role): Promise<DiscussionTarget> {
    await this.perms.requireProject(projectId, userId, required);
    const p = await this.prisma.project.findUnique({ where: { id: projectId }, select: { name: true, description: true } });
    if (!p) throw new NotFoundException("Project not found");
    return { scope: Scope.project, projectId, entityName: p.name, description: p.description };
  }

  private async resolveTarget(targetId: string, userId: string, required: Role): Promise<DiscussionTarget> {
    const { projectId } = await this.perms.requireTarget(targetId, userId, required);
    const t = await this.prisma.qaTarget.findUnique({
      where: { id: targetId },
      select: { name: true, description: true, kind: true, config: true },
    });
    if (!t) throw new NotFoundException("Target not found");
    return { scope: Scope.target, projectId, targetId, kind: t.kind, entityName: t.name, description: t.description };
  }

  private async resolve(scope: Scope, id: string, userId: string, required: Role): Promise<DiscussionTarget> {
    return scope === Scope.project
      ? this.resolveProject(id, userId, required)
      : this.resolveTarget(id, userId, required);
  }

  // ---------- read ----------

  async get(scope: Scope, id: string, userId: string) {
    const ctx = await this.resolve(scope, id, userId, Role.viewer);
    const discussion = await this.ensure(ctx);
    const items = checklistFor(ctx.scope, ctx.kind);
    const [messages, proposals] = await Promise.all([
      this.prisma.discussionMessage.findMany({ where: { discussionId: discussion.id }, orderBy: { createdAt: "asc" } }),
      this.prisma.targetProposal.findMany({ where: { discussionId: discussion.id }, orderBy: { createdAt: "asc" } }),
    ]);
    return {
      id: discussion.id,
      scope: ctx.scope,
      projectId: ctx.projectId,
      targetId: ctx.targetId ?? null,
      kind: ctx.kind ?? null,
      entityName: ctx.entityName,
      checklist: items,
      completeness: mergeCompleteness(items, (discussion.completeness ?? {}) as CompletenessMap, {}),
      draft: discussion.draft,
      messages,
      proposals,
      canPropose: ctx.scope === Scope.project,
    };
  }

  private async ensure(ctx: DiscussionTarget) {
    const where = ctx.scope === Scope.project ? { projectId: ctx.projectId } : { targetId: ctx.targetId! };
    const existing = await this.prisma.discussion.findFirst({ where });
    if (existing) return existing;
    return this.prisma.discussion.create({
      data: {
        scope: ctx.scope,
        projectId: ctx.scope === Scope.project ? ctx.projectId : null,
        targetId: ctx.scope === Scope.target ? ctx.targetId! : null,
        completeness: initialCompleteness(checklistFor(ctx.scope, ctx.kind)) as Prisma.InputJsonObject,
        // Seed the draft from the current description so editing continues from it.
        draft: ctx.description ?? "",
      },
    });
  }

  // ---------- one guided turn ----------

  async postMessage(scope: Scope, id: string, userId: string, content: string) {
    const ctx = await this.resolve(scope, id, userId, Role.editor);
    const discussion = await this.ensure(ctx);
    const items = checklistFor(ctx.scope, ctx.kind);

    // §4.1 "先文字與 URL": links pasted by the user are fetched and become context.
    const urls = extractUrls(content);
    const pages = urls.length ? await this.urls.fetchMany(urls) : [];
    if (pages.length) await this.storeAttachments(ctx.projectId, userId, pages);

    const userMessage = await this.prisma.discussionMessage.create({
      data: {
        discussionId: discussion.id,
        role: "user",
        content,
        references: pages.length
          ? (pages.map((p) => ({ url: p.url, title: p.title, chars: p.chars, error: p.error ?? null })) as Prisma.InputJsonValue)
          : undefined,
      },
    });

    const history = await this.prisma.discussionMessage.findMany({
      where: { discussionId: discussion.id, id: { not: userMessage.id } },
      orderBy: { createdAt: "desc" },
      take: HISTORY_LIMIT,
    });

    const current = mergeCompleteness(items, (discussion.completeness ?? {}) as CompletenessMap, {});
    const llmMessages: LlmMessage[] = [
      ...history.reverse().map((m): LlmMessage => ({ role: m.role === "user" ? "user" : "assistant", content: m.content })),
      { role: "user", content: buildUserTurn(content, pages) },
    ];

    const result = await this.gateway.structured("discuss", "discussion_turn", {
      system: buildSystemPrompt(ctx, items, current, discussion.draft),
      messages: llmMessages,
      maxTokens: 4096,
    }, { context: { projectId: ctx.projectId, targetId: ctx.targetId ?? null } });
    const turn = result.data;

    const nextDraft = applyDraftPatch(discussion.draft, turn.draft_patch);
    const nextCompleteness = mergeCompleteness(items, current, turn.completeness ?? {});

    const [assistantMessage] = await this.prisma.$transaction([
      this.prisma.discussionMessage.create({
        data: {
          discussionId: discussion.id,
          role: "assistant",
          content: turn.message,
          structured: turn as unknown as Prisma.InputJsonValue,
          llmConfigId: result.configId,
          model: result.model,
        },
      }),
      this.prisma.discussion.update({
        where: { id: discussion.id },
        data: { draft: nextDraft, completeness: nextCompleteness as Prisma.InputJsonObject },
      }),
    ]);

    // Target proposals are a Project-scope feature (§4.1); the LLM never creates a Target itself.
    const proposals =
      ctx.scope === Scope.project && turn.target_proposals?.length
        ? await this.prisma.$transaction(
            turn.target_proposals.slice(0, 5).map((p) =>
              this.prisma.targetProposal.create({
                data: {
                  discussionId: discussion.id,
                  messageId: assistantMessage.id,
                  kind: p.kind,
                  name: p.name,
                  config: (p.config ?? {}) as Prisma.InputJsonObject,
                  credentialKeys: p.credential_keys ?? [],
                  rationale: p.rationale ?? "",
                },
              }),
            ),
          )
        : [];

    return {
      userMessage,
      assistantMessage,
      turn,
      draft: nextDraft,
      completeness: nextCompleteness,
      proposals,
      llm: { model: result.model, configName: result.configName, fallbacks: result.fallbacks, attempts: result.attempts.length },
    };
  }

  private async storeAttachments(projectId: string, userId: string, pages: FetchedPage[]) {
    const usable = pages.filter((p) => !p.error);
    if (!usable.length) return;
    await this.prisma.projectAttachment.createMany({
      data: usable.map((p) => ({
        projectId,
        sourceType: "url" as const,
        filename: p.title ?? p.url,
        mime: "text/plain",
        url: p.url,
        textContent: p.text.slice(0, 100_000),
        byteSize: Buffer.byteLength(p.text),
        uploadedById: userId,
      })),
    });
  }

  // ---------- draft & description ----------

  async updateDraft(scope: Scope, id: string, userId: string, draft: string) {
    const ctx = await this.resolve(scope, id, userId, Role.editor);
    const discussion = await this.ensure(ctx);
    return this.prisma.discussion.update({ where: { id: discussion.id }, data: { draft } });
  }

  /** Spec §4.1: one-click "save as description" → new description_version, source=discussion. */
  async saveDescription(scope: Scope, id: string, userId: string, content?: string) {
    const ctx = await this.resolve(scope, id, userId, Role.editor);
    const discussion = await this.ensure(ctx);
    const text = (content ?? discussion.draft).trim();
    if (!text) throw new BadRequestException("描述草稿是空的");

    const saved =
      ctx.scope === Scope.project
        ? await this.projects.updateDescription(ctx.projectId, userId, text, DescriptionSource.discussion)
        : await this.targets.updateDescription(ctx.targetId!, userId, text, DescriptionSource.discussion);

    await this.prisma.discussion.update({ where: { id: discussion.id }, data: { draft: text } });
    await this.audit.log("user", userId, "discussion.save_description", ctx.targetId ?? ctx.projectId, {
      scope: ctx.scope,
      version: saved.descriptionVersion,
    });
    return saved;
  }

  // ---------- target proposals ----------

  async decideProposal(proposalId: string, userId: string, accept: boolean) {
    const proposal = await this.prisma.targetProposal.findUnique({
      where: { id: proposalId },
      include: { discussion: true },
    });
    if (!proposal) throw new NotFoundException("提案不存在");
    const projectId = proposal.discussion.projectId;
    if (!projectId) throw new BadRequestException("此提案沒有對應的 Project");
    if (proposal.status !== ProposalStatus.pending) {
      throw new BadRequestException(`提案已經是 ${proposal.status} 狀態`);
    }

    if (!accept) {
      await this.perms.requireProject(projectId, userId, Role.editor);
      return this.prisma.targetProposal.update({
        where: { id: proposalId },
        data: { status: ProposalStatus.rejected, decidedById: userId, decidedAt: new Date() },
      });
    }

    // Creating a Target is an owner action (§2.2), so accepting one is too.
    await this.perms.requireProject(projectId, userId, Role.owner);
    const target = await this.targets.create(projectId, userId, {
      name: proposal.name,
      kind: proposal.kind,
      config: (proposal.config ?? {}) as Record<string, unknown>,
      description: proposal.rationale,
    });
    const updated = await this.prisma.targetProposal.update({
      where: { id: proposalId },
      data: {
        status: ProposalStatus.accepted,
        createdTargetId: target.id,
        decidedById: userId,
        decidedAt: new Date(),
      },
    });
    await this.audit.log("user", userId, "discussion.proposal.accept", target.id, { proposalId, kind: proposal.kind });
    return { ...updated, target };
  }

  async attachments(projectId: string, userId: string) {
    await this.perms.requireProject(projectId, userId, Role.viewer);
    return this.prisma.projectAttachment.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      select: { id: true, sourceType: true, filename: true, mime: true, url: true, byteSize: true, createdAt: true },
    });
  }
}

// ---------- prompt construction ----------

function buildSystemPrompt(
  ctx: DiscussionTarget,
  items: ChecklistItem[],
  completeness: CompletenessMap,
  draft: string,
): string {
  const subject =
    ctx.scope === Scope.project
      ? `專案「${ctx.entityName}」`
      : `QA Target「${ctx.entityName}」（種類：${ctx.kind}）`;

  const lines = [
    `你是 QA Harness 的訪談助理，正在和使用者釐清 ${subject} 的細節，目的是產出一份夠精確的描述，之後用來自動生成測試案例。`,
    "",
    "## 你的工作方式",
    "- 帶著下面的「必須釐清項目」主動提問，不要等使用者自己想到要講什麼。",
    "- 每一輪最多問 3 個問題，優先問狀態為 unknown 的項目，一次聚焦一兩個主題。",
    "- 使用者回答後，把新資訊整理進描述草稿，並更新每個項目的完整度。",
    "- 所有項目都是 clear 時，不要再硬問，改為請使用者確認描述草稿。",
    "- 用繁體中文回覆，語氣直接、具體，不要客套。",
    "",
    "## 必須釐清項目",
    ...items.map((i) => `- \`${i.key}\`（${i.label}）：${i.hint} — 目前狀態：${completeness[i.key] ?? "unknown"}`),
    "",
    "## 欄位怎麼填",
    "- `message`：給使用者看的回覆，先簡短整理你剛學到什麼，再帶出問題。",
    "- `questions`：本輪的問題，每題標註它要釐清哪個項目 key，最多 3 題；沒有問題就給空陣列。",
    "- `draft_patch`：`mode` 用 `replace` 時 `content` 是整份新的描述草稿；`append` 時只給要接在後面的段落；沒有要改就用 `none` 並把 `content` 設為空字串。",
    "- `completeness`：只使用上面列出的 key，值為 unknown / partial / clear。沒有變動的項目也要照原狀回報。",
  ];

  if (ctx.scope === Scope.project) {
    lines.push(
      "- `target_proposals`：當「被測面」已經清楚，且使用者尚未建立對應的 QA Target 時，提出建議。`kind` 只能是 api / web / desktop，`config` 依 kind 填，值一律是字串（api：base_url、openapi_url、headers；web：url、viewport，viewport 格式為「1280x800」這種字串；desktop：image、install_command、launch_command），`credential_keys` 只寫需要的欄位名稱，不要寫真實密碼。其他時候給空陣列。",
      "- 你不能直接建立 Target，只能提案，由使用者確認。",
    );
  } else {
    lines.push("- `target_proposals`：這是 Target 討論區，一律給空陣列。");
  }

  lines.push(
    "",
    "## 目前的描述草稿",
    draft.trim() ? "```markdown\n" + draft.trim().slice(0, 8000) + "\n```" : "（還沒有內容）",
  );

  if (ctx.description?.trim() && ctx.description.trim() !== draft.trim()) {
    lines.push("", "## 已儲存的描述（上一版）", "```markdown\n" + ctx.description.trim().slice(0, 4000) + "\n```");
  }
  return lines.join("\n");
}

function buildUserTurn(content: string, pages: FetchedPage[]): string {
  if (!pages.length) return content;
  const blocks = pages.map((p) =>
    p.error
      ? `### ${p.url}\n（抓取失敗：${p.error}）`
      : `### ${p.title ?? p.url}\n來源：${p.url}\n\n${p.text}`,
  );
  return [content, "", "---", "以下是使用者訊息中連結的內容，請一併參考：", "", ...blocks].join("\n");
}

function applyDraftPatch(draft: string, patch: DiscussionTurn["draft_patch"]): string {
  if (!patch || patch.mode === "none") return draft;
  if (patch.mode === "replace") return patch.content;
  const addition = patch.content.trim();
  if (!addition) return draft;
  return draft.trim() ? `${draft.trim()}\n\n${addition}` : addition;
}
