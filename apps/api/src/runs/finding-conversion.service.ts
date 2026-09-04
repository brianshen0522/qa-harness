import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { CaseSource, CaseStatus, FindingStatus, Prisma, Priority, Role, type CaseType } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionsService } from "../permissions/permissions.service";
import { LlmGatewayService } from "../llm/llm-gateway.service";
import { AuditService } from "../audit/audit.service";

export interface CaseDraft {
  title: string;
  precondition: string;
  steps: string[];
  expected: string;
  priority: Priority;
  type: CaseType;
  featureId: string | null;
  featureName: string | null;
}

const DRAFT_SYSTEM = [
  "你是 QA Harness 的測試案例撰寫者。執行過程中代理注意到一個和當時那條案例無關的問題（finding），",
  "現在要把它變成一條可以重複執行的測試案例，讓這個問題之後不會再無聲無息地跑掉。",
  "",
  "- 只回傳「一條」案例，放在 `cases` 陣列裡。",
  "- 案例要驗的是「這個問題有沒有被修好」，所以 `expected` 要寫「正確的行為應該是什麼」，不是重述錯誤。",
  "- `steps` 要具體到別人照著做就能重現，不要只寫「重現該問題」。",
  "- 這是回歸案例，`type` 用 `negative` 或 `edge` 通常比 `happy` 合適；嚴重的問題給 P0 / P1。",
].join("\n");

/**
 * Spec §4.7: a finding can be turned into a test case in one click. The model
 * drafts it, a person confirms it — a finding is an observation, and turning an
 * observation into a permanent test is a decision worth seeing before it lands.
 */
@Injectable()
export class FindingConversionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionsService,
    private readonly gateway: LlmGatewayService,
    private readonly audit: AuditService,
  ) {}

  /** Drafts a case from the finding. Writes nothing. */
  async draft(findingId: string, userId: string): Promise<CaseDraft & { findingId: string; model: string }> {
    const finding = await this.load(findingId);
    await this.perms.requireTarget(finding.run.targetId, userId, Role.editor);

    const target = await this.prisma.qaTarget.findUniqueOrThrow({
      where: { id: finding.run.targetId },
      select: { name: true, kind: true, description: true },
    });
    const features = await this.prisma.feature.findMany({
      where: { targetId: finding.run.targetId, status: "active" },
      select: { id: true, name: true },
      orderBy: { order: "asc" },
    });
    const sourceCase = finding.testCaseId
      ? await this.prisma.testCase.findUnique({
          where: { id: finding.testCaseId },
          select: { title: true, steps: true },
        })
      : null;

    const res = await this.gateway.structured("generate", "test_case", {
      system: DRAFT_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            `# 被測目標\n${target.name}（種類：${target.kind}）`,
            "",
            "## 描述",
            target.description.trim().slice(0, 20_000) || "（沒有描述）",
            "",
            "## 這次的 finding",
            `嚴重程度：${finding.severity}`,
            `標題：${finding.title}`,
            finding.description.trim() ? `說明：${finding.description.trim().slice(0, 4000)}` : "",
            sourceCase
              ? `\n代理是在跑「${sourceCase.title}」時注意到的，那條案例的步驟是：\n${((sourceCase.steps as string[]) ?? []).map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`
              : "",
            "",
            features.length
              ? `## 現有功能\n${features.map((f) => `- ${f.name}`).join("\n")}\n\n\`feature_ref\` 請從上面挑一個最貼近的，真的都不合適才給新名稱。`
              : "## 現有功能\n（還沒有功能，`feature_ref` 自己取一個貼切的名稱）",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
      maxTokens: 2048,
    });

    const written = res.data.cases?.[0];
    if (!written) throw new BadRequestException("模型沒有寫出案例內容，請再試一次。");
    const matched = features.find((f) => f.name === written.feature_ref?.trim());

    return {
      findingId,
      model: res.model,
      title: written.title?.trim() || finding.title,
      precondition: written.precondition?.trim() ?? "",
      steps: (written.steps ?? []).map((s) => s.trim()).filter(Boolean),
      expected: written.expected?.trim() ?? "",
      priority: (written.priority as Priority) ?? Priority.P2,
      type: (written.type as CaseType) ?? "negative",
      featureId: matched?.id ?? null,
      featureName: matched?.name ?? written.feature_ref?.trim() ?? null,
    };
  }

  /** Saves the confirmed draft as a real case and marks the finding converted. */
  async convert(findingId: string, userId: string, input: Omit<CaseDraft, "featureName"> & { featureName?: string | null }) {
    const finding = await this.load(findingId);
    const targetId = finding.run.targetId;
    await this.perms.requireTarget(targetId, userId, Role.editor);
    if (finding.convertedCaseId) {
      throw new BadRequestException("這個 finding 已經轉成測試案例了。");
    }
    if (!input.title?.trim()) throw new BadRequestException("標題不能是空的");
    const steps = (input.steps ?? []).map((s) => s.trim()).filter(Boolean);
    if (!steps.length) throw new BadRequestException("至少要有一個步驟");
    if (!input.expected?.trim()) throw new BadRequestException("預期結果不能是空的");

    const target = await this.prisma.qaTarget.findUniqueOrThrow({
      where: { id: targetId },
      select: { descriptionVersion: true },
    });

    const created = await this.prisma.$transaction(async (tx) => {
      let featureId = input.featureId ?? null;
      if (featureId) {
        const owned = await tx.feature.findUnique({ where: { id: featureId } });
        if (!owned || owned.targetId !== targetId) featureId = null;
      }
      if (!featureId && input.featureName?.trim()) {
        const order = ((await tx.feature.aggregate({ where: { targetId }, _max: { order: true } }))._max.order ?? -1) + 1;
        const row = await tx.feature.upsert({
          where: { targetId_name: { targetId, name: input.featureName.trim() } },
          create: {
            targetId, name: input.featureName.trim(), order,
            basedOnDescriptionVersion: target.descriptionVersion,
          },
          update: {},
        });
        featureId = row.id;
      }

      const order = ((await tx.testCase.aggregate({ where: { targetId }, _max: { order: true } }))._max.order ?? -1) + 1;
      const row = await tx.testCase.create({
        data: {
          targetId, featureId,
          title: input.title.trim(),
          precondition: input.precondition?.trim() ?? "",
          steps: steps as Prisma.InputJsonValue,
          expected: input.expected.trim(),
          priority: input.priority ?? Priority.P2,
          type: (input.type ?? "negative") as CaseType,
          // Its own source, so "where did this case come from" stays answerable.
          source: CaseSource.finding,
          status: CaseStatus.active,
          order,
          basedOnDescriptionVersion: target.descriptionVersion,
          createdById: userId,
        },
      });
      await tx.testCaseVersion.create({
        data: {
          testCaseId: row.id,
          version: 1,
          content: {
            title: row.title, precondition: row.precondition, steps: row.steps,
            expected: row.expected, priority: row.priority, type: row.type,
            status: row.status, featureId: row.featureId,
          } as Prisma.InputJsonObject,
          createdBy: userId,
        },
      });
      await tx.runFinding.update({
        where: { id: findingId },
        data: { status: FindingStatus.converted_to_case, convertedCaseId: row.id },
      });
      return row;
    });

    await this.audit.log("user", userId, "finding.convert_case", findingId, {
      targetId, caseId: created.id, severity: finding.severity,
    });
    return created;
  }

  private async load(findingId: string) {
    const finding = await this.prisma.runFinding.findUnique({
      where: { id: findingId },
      include: { run: { select: { targetId: true } } },
    });
    if (!finding) throw new NotFoundException("Finding 不存在");
    return finding;
  }
}
