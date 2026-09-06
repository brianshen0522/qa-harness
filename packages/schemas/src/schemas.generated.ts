// AUTO-GENERATED from /schemas/*.json — do not edit.
/* eslint-disable */
export const case_verdictSchema = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "qa-harness/case_verdict",
  "title": "case_verdict",
  "description": "Final verdict for one test case in a run.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema_version",
    "verdict",
    "reasoning",
    "evidence_refs",
    "repro_steps",
    "possibly_changed"
  ],
  "properties": {
    "schema_version": {
      "type": "string",
      "const": "1.0"
    },
    "verdict": {
      "type": "string",
      "enum": [
        "pass",
        "fail",
        "blocked",
        "skipped"
      ]
    },
    "reasoning": {
      "type": "string",
      "minLength": 1
    },
    "evidence_refs": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "repro_steps": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "possibly_changed": {
      "type": "boolean"
    }
  },
  "if": {
    "properties": {
      "verdict": {
        "const": "fail"
      }
    }
  },
  "then": {
    "properties": {
      "repro_steps": {
        "minItems": 1
      }
    }
  }
} as const;

export const change_proposalSchema = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "qa-harness/change_proposal",
  "title": "change_proposal",
  "description": "Structured change proposal produced by the LLM. Never applied automatically.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema_version",
    "summary",
    "description_diff",
    "description_after",
    "feature_changes",
    "test_case_changes"
  ],
  "properties": {
    "schema_version": {
      "type": "string",
      "const": "1.0"
    },
    "summary": {
      "type": "string"
    },
    "description_diff": {
      "type": "string",
      "description": "給人看的描述前後差異（unified diff 或條列說明）。沒有描述變動時給空字串。"
    },
    "description_after": {
      "type": "string",
      "description": "套用後完整的描述內容。描述沒有變動時給空字串。"
    },
    "feature_changes": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "op",
          "reason"
        ],
        "properties": {
          "op": {
            "type": "string",
            "enum": [
              "add",
              "modify",
              "remove"
            ]
          },
          "feature_id": {
            "type": [
              "string",
              "null"
            ]
          },
          "name": {
            "type": "string"
          },
          "description": {
            "type": "string"
          },
          "reason": {
            "type": "string"
          }
        }
      }
    },
    "test_case_changes": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "op",
          "reason"
        ],
        "properties": {
          "op": {
            "type": "string",
            "enum": [
              "add",
              "modify",
              "mark_outdated",
              "deprecate"
            ]
          },
          "case_id": {
            "type": [
              "string",
              "null"
            ]
          },
          "feature_ref": {
            "type": "string"
          },
          "before": {
            "type": [
              "object",
              "null"
            ],
            "additionalProperties": true
          },
          "after": {
            "type": [
              "object",
              "null"
            ],
            "additionalProperties": true
          },
          "reason": {
            "type": "string"
          }
        }
      }
    }
  }
} as const;

export const discussion_turnSchema = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "qa-harness/discussion_turn",
  "title": "discussion_turn",
  "description": "One LLM turn in the guided discussion for a Project or Target.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema_version",
    "message",
    "questions",
    "draft_patch",
    "completeness",
    "target_proposals"
  ],
  "properties": {
    "schema_version": {
      "type": "string",
      "const": "1.0"
    },
    "message": {
      "type": "string",
      "description": "Reply shown to the user (markdown)."
    },
    "questions": {
      "type": "array",
      "maxItems": 3,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "item",
          "question"
        ],
        "properties": {
          "item": {
            "type": "string",
            "description": "Checklist item key this question clarifies."
          },
          "question": {
            "type": "string"
          }
        }
      }
    },
    "draft_patch": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "mode",
        "content"
      ],
      "properties": {
        "mode": {
          "type": "string",
          "enum": [
            "none",
            "replace",
            "append"
          ]
        },
        "content": {
          "type": "string",
          "description": "Markdown to replace or append to the draft description."
        }
      }
    },
    "completeness": {
      "type": "object",
      "description": "Checklist item key -> status.",
      "additionalProperties": {
        "type": "string",
        "enum": [
          "unknown",
          "partial",
          "clear"
        ]
      }
    },
    "target_proposals": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "name",
          "config",
          "credential_keys",
          "rationale"
        ],
        "properties": {
          "kind": {
            "type": "string",
            "enum": [
              "api",
              "web",
              "desktop"
            ]
          },
          "name": {
            "type": "string"
          },
          "config": {
            "type": "object",
            "additionalProperties": true
          },
          "credential_keys": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "rationale": {
            "type": "string"
          }
        }
      }
    }
  }
} as const;

export const execution_stepSchema = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "qa-harness/execution_step",
  "title": "execution_step",
  "description": "One agent step while executing a test case.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema_version",
    "phase",
    "observation",
    "intent",
    "action"
  ],
  "properties": {
    "schema_version": {
      "type": "string",
      "const": "1.0"
    },
    "phase": {
      "type": "string",
      "enum": [
        "setup",
        "executing",
        "verifying",
        "judging"
      ]
    },
    "observation": {
      "type": "string",
      "description": "畫面上實際看到什麼：元素、文字、目前狀態。必填，每一步都要重寫。"
    },
    "intent": {
      "type": "string",
      "description": "這一步想達成什麼。"
    },
    "action": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "type",
        "params"
      ],
      "properties": {
        "type": {
          "type": "string",
          "enum": [
            "screenshot",
            "page_snapshot",
            "click_text",
            "fill_field",
            "press_key",
            "set_viewport",
            "click",
            "double_click",
            "right_click",
            "type",
            "key",
            "scroll",
            "move",
            "wait",
            "http_request",
            "navigate",
            "run_command",
            "mcp_call",
            "rotate_credential",
            "report_finding",
            "abort_run",
            "done"
          ],
          "description": "要執行的動作。畫面類 Target 優先用「看得到元素」的動作：`page_snapshot`（讀出目前頁面的連結、表單欄位、按鈕、以及畫面上的錯誤／提示訊息，params 空）、`click_text`（依可見文字點連結/按鈕，params 給 `{ text, exact?}`）、`fill_field`（依欄位名稱或 label 填值，params 給 `{ field, value }`）、`press_key`（送一個按鍵，params 給 `{ key }`，如 Enter/Escape）、`set_viewport`（改視窗尺寸測 RWD，params 給 `{ width, height, mobile? }`）。座標類的 `click`/`type`/`scroll` 只在前述動作做不到時當退路。`report_finding` 用來記下與目前 case 無關的問題，記完會繼續原本的流程；`mcp_call` 呼叫外部 MCP 工具（params 給 server_id、tool、arguments）；`rotate_credential` 用在「這條 case 要修改某個憑證的值（例如改密碼）」時，params 給 `{ credential: 憑證名稱 }`，系統會產生一組新值並讓你用 `{{憑證名稱__next}}` 代入，改成功後平台會自動把儲存的憑證同步成新值；`abort_run` 用在「整個被測系統根本連不上／沒啟動」這種系統性致命錯誤，params 給 `{ reason }`，會中止整趟執行（不要用在單一頁面或單一 API 的錯誤）；`done` 結束這條 case。"
        },
        "params": {
          "type": "object",
          "additionalProperties": true
        }
      },
      "description": "依據上面的觀察決定的下一個動作。"
    }
  }
} as const;

export const exploration_notesSchema = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "qa-harness/exploration_notes",
  "title": "exploration_notes",
  "description": "Deep, read-only look at one page: scenarios worth testing and any visible defect. The explorer never submits or mutates; it only observes.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema_version",
    "scenarios",
    "findings"
  ],
  "properties": {
    "schema_version": {
      "type": "string",
      "const": "1.0"
    },
    "scenarios": {
      "type": "array",
      "description": "情境：這個頁面值得測的狀況，之後會變成測試案例的素材。",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "title",
          "rationale"
        ],
        "properties": {
          "title": {
            "type": "string",
            "minLength": 1
          },
          "rationale": {
            "type": "string"
          },
          "risk": {
            "type": "string",
            "enum": [
              "high",
              "medium",
              "low"
            ]
          }
        }
      }
    },
    "findings": {
      "type": "array",
      "description": "當下就看得出來的問題（版面壞掉、錯誤訊息、明顯不一致）。沒有就給空陣列。",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "severity",
          "title",
          "description"
        ],
        "properties": {
          "severity": {
            "type": "string",
            "enum": [
              "critical",
              "major",
              "minor",
              "info"
            ]
          },
          "title": {
            "type": "string",
            "minLength": 1
          },
          "description": {
            "type": "string"
          }
        }
      }
    }
  }
} as const;

export const feature_listSchema = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "qa-harness/feature_list",
  "title": "feature_list",
  "description": "Generation pipeline step 1: feature inventory for a Target.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema_version",
    "features"
  ],
  "properties": {
    "schema_version": {
      "type": "string",
      "const": "1.0"
    },
    "features": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "name",
          "description"
        ],
        "properties": {
          "name": {
            "type": "string",
            "minLength": 1
          },
          "description": {
            "type": "string"
          }
        }
      }
    }
  }
} as const;

export const findingSchema = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "qa-harness/finding",
  "title": "finding",
  "description": "An issue discovered during execution that is unrelated to the current case.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema_version",
    "severity",
    "title",
    "description",
    "evidence_refs",
    "related_feature_ref"
  ],
  "properties": {
    "schema_version": {
      "type": "string",
      "const": "1.0"
    },
    "severity": {
      "type": "string",
      "enum": [
        "critical",
        "major",
        "minor",
        "info"
      ]
    },
    "title": {
      "type": "string",
      "minLength": 1
    },
    "description": {
      "type": "string"
    },
    "evidence_refs": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "related_feature_ref": {
      "type": [
        "string",
        "null"
      ]
    }
  }
} as const;

export const handoff_documentSchema = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "qa-harness/handoff_document",
  "title": "handoff_document",
  "description": "Parsed representation of a coding-agent handoff document (markdown with YAML front-matter).",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema_version",
    "front_matter",
    "sections"
  ],
  "properties": {
    "schema_version": {
      "type": "string",
      "const": "1.0"
    },
    "front_matter": {
      "type": "object",
      "additionalProperties": true,
      "required": [
        "harness_version",
        "scope",
        "generated_at"
      ],
      "properties": {
        "harness_version": {
          "type": "string"
        },
        "scope": {
          "type": "string",
          "enum": [
            "project",
            "target"
          ]
        },
        "target_kind": {
          "type": [
            "string",
            "null"
          ],
          "enum": [
            "api",
            "web",
            "desktop",
            null
          ]
        },
        "generated_at": {
          "type": "string"
        }
      }
    },
    "sections": {
      "type": "object",
      "description": "Section title -> markdown body. Known titles are imported structurally; unknown ones are kept as description text.",
      "additionalProperties": {
        "type": "string"
      }
    },
    "suggested_test_cases": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "title"
        ],
        "properties": {
          "feature": {
            "type": "string"
          },
          "title": {
            "type": "string"
          },
          "steps": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "expected": {
            "type": "string"
          }
        }
      }
    },
    "detected_secrets": {
      "type": "array",
      "description": "Keys that look like credentials found in the document; user is prompted to move them to encrypted storage.",
      "items": {
        "type": "string"
      }
    }
  }
} as const;

export const test_caseSchema = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "qa-harness/test_case",
  "title": "test_case",
  "description": "Generation pipeline step 2: test cases for one feature.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema_version",
    "cases"
  ],
  "properties": {
    "schema_version": {
      "type": "string",
      "const": "1.0"
    },
    "cases": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "feature_ref",
          "title",
          "precondition",
          "steps",
          "expected",
          "priority",
          "type"
        ],
        "properties": {
          "feature_ref": {
            "type": "string",
            "description": "Feature name this case belongs to."
          },
          "title": {
            "type": "string",
            "minLength": 1
          },
          "precondition": {
            "type": "string"
          },
          "steps": {
            "type": "array",
            "minItems": 1,
            "items": {
              "type": "string"
            }
          },
          "expected": {
            "type": "string",
            "minLength": 1
          },
          "priority": {
            "type": "string",
            "enum": [
              "P0",
              "P1",
              "P2",
              "P3"
            ]
          },
          "type": {
            "type": "string",
            "enum": [
              "happy",
              "edge",
              "negative"
            ]
          }
        }
      }
    }
  }
} as const;

export const SCHEMAS = {
  case_verdict: case_verdictSchema,
  change_proposal: change_proposalSchema,
  discussion_turn: discussion_turnSchema,
  execution_step: execution_stepSchema,
  exploration_notes: exploration_notesSchema,
  feature_list: feature_listSchema,
  finding: findingSchema,
  handoff_document: handoff_documentSchema,
  test_case: test_caseSchema,
} as const;

export type SchemaName = keyof typeof SCHEMAS;
export const SCHEMA_NAMES = Object.keys(SCHEMAS) as SchemaName[];
