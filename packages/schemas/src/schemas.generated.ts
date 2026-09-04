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
      "description": "Unified diff of the description, or empty string."
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
            "done"
          ]
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
  feature_list: feature_listSchema,
  finding: findingSchema,
  handoff_document: handoff_documentSchema,
  test_case: test_caseSchema,
} as const;

export type SchemaName = keyof typeof SCHEMAS;
export const SCHEMA_NAMES = Object.keys(SCHEMAS) as SchemaName[];
