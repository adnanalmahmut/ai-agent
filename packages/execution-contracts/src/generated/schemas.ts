/**
 * Generated from contracts/execution/v1 by scripts/generate.mjs.
 * Do not edit. Change the schema and run `pnpm execution:contracts`.
 */

/* eslint-disable */

export const ArtifactRefSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://contracts.ai-agent.local/execution/v1/artifact-ref.schema.json",
  "title": "ArtifactRef",
  "description": "A pointer to stored bytes. Deliberately not a URL and not a credential: resolving a reference is a service boundary's job, and a signed link placed here would outlive the authorization that made it.",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "version": {
      "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/version"
    },
    "ref": {
      "description": "An opaque storage reference the Control Plane can resolve.",
      "allOf": [
        {
          "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/identifier"
        }
      ]
    },
    "contentType": {
      "description": "An IANA media type, without parameters.",
      "type": "string",
      "minLength": 3,
      "maxLength": 255,
      "pattern": "^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$"
    },
    "byteSize": {
      "description": "Size of the stored bytes. The ceiling is an explicit conservative one; no existing limit governs artifacts yet.",
      "type": "integer",
      "minimum": 0,
      "maximum": 67108864
    },
    "digest": {
      "description": "Lowercase hex SHA-256 of the stored bytes.",
      "type": "string",
      "pattern": "^[0-9a-f]{64}$"
    }
  },
  "required": [
    "version",
    "ref",
    "contentType",
    "byteSize",
    "digest"
  ]
} as const;

export const CommonSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://contracts.ai-agent.local/execution/v1/common.schema.json",
  "title": "Execution v1 common definitions",
  "description": "Primitives every execution v1 document is built from. Bounds are not invented here: each one is either a limit the deployment already enforces or an explicit conservative ceiling named in contracts/README.md.",
  "$defs": {
    "version": {
      "title": "ExecutionVersion",
      "description": "The contract this document is written against.",
      "const": "1"
    },
    "identifier": {
      "title": "ExecutionIdentifier",
      "description": "An opaque identifier. The ceiling matches the idempotency-key bound the HTTP surface already enforces.",
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "toolRef": {
      "title": "ExecutionToolRef",
      "description": "A versioned tool reference, `id@version`.",
      "type": "string",
      "minLength": 3,
      "maxLength": 200,
      "pattern": "^[a-z0-9]+(?:[.-][a-z0-9]+)*@[1-9][0-9]{0,4}$"
    },
    "timestamp": {
      "title": "ExecutionTimestamp",
      "description": "An instant, as an ISO-8601 date-time string. Never a language date object: those do not survive JSON.",
      "type": "string",
      "format": "date-time",
      "minLength": 20,
      "maxLength": 40
    },
    "count": {
      "title": "ExecutionCount",
      "description": "A non-negative whole number, ceilinged at PostgreSQL's Int, which is the column type these values are stored in.",
      "type": "integer",
      "minimum": 0,
      "maximum": 2147483647
    },
    "attempt": {
      "title": "ExecutionAttempt",
      "description": "A delivery ordinal. Attempts start at one.",
      "type": "integer",
      "minimum": 1,
      "maximum": 2147483647
    },
    "shortText": {
      "title": "ExecutionShortText",
      "description": "Bounded human-readable text. The ceiling matches the longest free-text field the HTTP surface accepts today.",
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    },
    "sensitiveNamePattern": {
      "title": "ExecutionSensitiveNamePattern",
      "description": "Property names an execution document may never carry. Applied to every level of a payload, not only the top one.",
      "type": "string",
      "const": "^(?:[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Pp][Aa][Ss][Ss][Ww][Dd]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Cc][Ll][Ii][Ee][Nn][Tt][-_]?[Ss][Ee][Cc][Rr][Ee][Tt]|[Tt][Oo][Kk][Ee][Nn]|[Bb][Ee][Aa][Rr][Ee][Rr]|[Aa][Cc][Cc][Ee][Ss][Ss][-_]?[Tt][Oo][Kk][Ee][Nn]|[Rr][Ee][Ff][Rr][Ee][Ss][Hh][-_]?[Tt][Oo][Kk][Ee][Nn]|[Ii][Dd][-_]?[Tt][Oo][Kk][Ee][Nn]|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll]|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll][Ss]|[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]|[Aa][Uu][Tt][Hh][-_]?[Hh][Ee][Aa][Dd][Ee][Rr]|[Aa][Pp][Ii][-_]?[Kk][Ee][Yy]|[Pp][Rr][Ii][Vv][Aa][Tt][Ee][-_]?[Kk][Ee][Yy]|[Pp][Uu][Bb][Ll][Ii][Cc][-_]?[Kk][Ee][Yy]|[Ee][Nn][Cc][Rr][Yy][Pp][Tt][Ii][Oo][Nn][-_]?[Kk][Ee][Yy]|[Dd][Aa][Tt][Aa][-_]?[Kk][Ee][Yy]|[Ss][Ee][Ss][Ss][Ii][Oo][Nn][-_]?[Ii][Dd]|[Cc][Oo][Oo][Kk][Ii][Ee]|[Ss][Ee][Tt][-_]?[Cc][Oo][Oo][Kk][Ii][Ee]|[Cc][Ii][Pp][Hh][Ee][Rr][Tt][Ee][Xx][Tt]|[Pp][Ll][Aa][Ii][Nn][Tt][Ee][Xx][Tt]|[Ss][Ii][Gg][Nn][Aa][Tt][Uu][Rr][Ee]|[Cc][Oo][Nn][Nn][Ee][Cc][Tt][Ii][Oo][Nn][-_]?[Ss][Tt][Rr][Ii][Nn][Gg])$"
    },
    "payload": {
      "title": "ExecutionPayload",
      "description": "Arbitrary agent data, bounded in width, depth and key naming. Total size is a separate budget the validator enforces, because JSON Schema cannot express bytes.",
      "$ref": "#/$defs/payloadLevel6"
    },
    "payloadLevel0": {
      "title": "ExecutionPayloadLevel0",
      "description": "The deepest level a payload may reach: scalars only.",
      "anyOf": [
        {
          "type": "string",
          "maxLength": 65536
        },
        {
          "type": "number",
          "minimum": -1e+308,
          "maximum": 1e+308
        },
        {
          "type": "boolean"
        },
        {
          "type": "null"
        }
      ]
    },
    "payloadLevel1": {
      "title": "ExecutionPayloadLevel1",
      "description": "A payload value with at most 1 further levels beneath it.",
      "anyOf": [
        {
          "type": "string",
          "maxLength": 65536
        },
        {
          "type": "number",
          "minimum": -1e+308,
          "maximum": 1e+308
        },
        {
          "type": "boolean"
        },
        {
          "type": "null"
        },
        {
          "type": "array",
          "maxItems": 256,
          "items": {
            "$ref": "#/$defs/payloadLevel0"
          }
        },
        {
          "type": "object",
          "maxProperties": 128,
          "propertyNames": {
            "maxLength": 200,
            "not": {
              "pattern": "^(?:[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Pp][Aa][Ss][Ss][Ww][Dd]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Cc][Ll][Ii][Ee][Nn][Tt][-_]?[Ss][Ee][Cc][Rr][Ee][Tt]|[Tt][Oo][Kk][Ee][Nn]|[Bb][Ee][Aa][Rr][Ee][Rr]|[Aa][Cc][Cc][Ee][Ss][Ss][-_]?[Tt][Oo][Kk][Ee][Nn]|[Rr][Ee][Ff][Rr][Ee][Ss][Hh][-_]?[Tt][Oo][Kk][Ee][Nn]|[Ii][Dd][-_]?[Tt][Oo][Kk][Ee][Nn]|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll]|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll][Ss]|[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]|[Aa][Uu][Tt][Hh][-_]?[Hh][Ee][Aa][Dd][Ee][Rr]|[Aa][Pp][Ii][-_]?[Kk][Ee][Yy]|[Pp][Rr][Ii][Vv][Aa][Tt][Ee][-_]?[Kk][Ee][Yy]|[Pp][Uu][Bb][Ll][Ii][Cc][-_]?[Kk][Ee][Yy]|[Ee][Nn][Cc][Rr][Yy][Pp][Tt][Ii][Oo][Nn][-_]?[Kk][Ee][Yy]|[Dd][Aa][Tt][Aa][-_]?[Kk][Ee][Yy]|[Ss][Ee][Ss][Ss][Ii][Oo][Nn][-_]?[Ii][Dd]|[Cc][Oo][Oo][Kk][Ii][Ee]|[Ss][Ee][Tt][-_]?[Cc][Oo][Oo][Kk][Ii][Ee]|[Cc][Ii][Pp][Hh][Ee][Rr][Tt][Ee][Xx][Tt]|[Pp][Ll][Aa][Ii][Nn][Tt][Ee][Xx][Tt]|[Ss][Ii][Gg][Nn][Aa][Tt][Uu][Rr][Ee]|[Cc][Oo][Nn][Nn][Ee][Cc][Tt][Ii][Oo][Nn][-_]?[Ss][Tt][Rr][Ii][Nn][Gg])$"
            }
          },
          "additionalProperties": {
            "$ref": "#/$defs/payloadLevel0"
          }
        }
      ]
    },
    "payloadLevel2": {
      "title": "ExecutionPayloadLevel2",
      "description": "A payload value with at most 2 further levels beneath it.",
      "anyOf": [
        {
          "type": "string",
          "maxLength": 65536
        },
        {
          "type": "number",
          "minimum": -1e+308,
          "maximum": 1e+308
        },
        {
          "type": "boolean"
        },
        {
          "type": "null"
        },
        {
          "type": "array",
          "maxItems": 256,
          "items": {
            "$ref": "#/$defs/payloadLevel1"
          }
        },
        {
          "type": "object",
          "maxProperties": 128,
          "propertyNames": {
            "maxLength": 200,
            "not": {
              "pattern": "^(?:[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Pp][Aa][Ss][Ss][Ww][Dd]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Cc][Ll][Ii][Ee][Nn][Tt][-_]?[Ss][Ee][Cc][Rr][Ee][Tt]|[Tt][Oo][Kk][Ee][Nn]|[Bb][Ee][Aa][Rr][Ee][Rr]|[Aa][Cc][Cc][Ee][Ss][Ss][-_]?[Tt][Oo][Kk][Ee][Nn]|[Rr][Ee][Ff][Rr][Ee][Ss][Hh][-_]?[Tt][Oo][Kk][Ee][Nn]|[Ii][Dd][-_]?[Tt][Oo][Kk][Ee][Nn]|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll]|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll][Ss]|[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]|[Aa][Uu][Tt][Hh][-_]?[Hh][Ee][Aa][Dd][Ee][Rr]|[Aa][Pp][Ii][-_]?[Kk][Ee][Yy]|[Pp][Rr][Ii][Vv][Aa][Tt][Ee][-_]?[Kk][Ee][Yy]|[Pp][Uu][Bb][Ll][Ii][Cc][-_]?[Kk][Ee][Yy]|[Ee][Nn][Cc][Rr][Yy][Pp][Tt][Ii][Oo][Nn][-_]?[Kk][Ee][Yy]|[Dd][Aa][Tt][Aa][-_]?[Kk][Ee][Yy]|[Ss][Ee][Ss][Ss][Ii][Oo][Nn][-_]?[Ii][Dd]|[Cc][Oo][Oo][Kk][Ii][Ee]|[Ss][Ee][Tt][-_]?[Cc][Oo][Oo][Kk][Ii][Ee]|[Cc][Ii][Pp][Hh][Ee][Rr][Tt][Ee][Xx][Tt]|[Pp][Ll][Aa][Ii][Nn][Tt][Ee][Xx][Tt]|[Ss][Ii][Gg][Nn][Aa][Tt][Uu][Rr][Ee]|[Cc][Oo][Nn][Nn][Ee][Cc][Tt][Ii][Oo][Nn][-_]?[Ss][Tt][Rr][Ii][Nn][Gg])$"
            }
          },
          "additionalProperties": {
            "$ref": "#/$defs/payloadLevel1"
          }
        }
      ]
    },
    "payloadLevel3": {
      "title": "ExecutionPayloadLevel3",
      "description": "A payload value with at most 3 further levels beneath it.",
      "anyOf": [
        {
          "type": "string",
          "maxLength": 65536
        },
        {
          "type": "number",
          "minimum": -1e+308,
          "maximum": 1e+308
        },
        {
          "type": "boolean"
        },
        {
          "type": "null"
        },
        {
          "type": "array",
          "maxItems": 256,
          "items": {
            "$ref": "#/$defs/payloadLevel2"
          }
        },
        {
          "type": "object",
          "maxProperties": 128,
          "propertyNames": {
            "maxLength": 200,
            "not": {
              "pattern": "^(?:[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Pp][Aa][Ss][Ss][Ww][Dd]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Cc][Ll][Ii][Ee][Nn][Tt][-_]?[Ss][Ee][Cc][Rr][Ee][Tt]|[Tt][Oo][Kk][Ee][Nn]|[Bb][Ee][Aa][Rr][Ee][Rr]|[Aa][Cc][Cc][Ee][Ss][Ss][-_]?[Tt][Oo][Kk][Ee][Nn]|[Rr][Ee][Ff][Rr][Ee][Ss][Hh][-_]?[Tt][Oo][Kk][Ee][Nn]|[Ii][Dd][-_]?[Tt][Oo][Kk][Ee][Nn]|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll]|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll][Ss]|[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]|[Aa][Uu][Tt][Hh][-_]?[Hh][Ee][Aa][Dd][Ee][Rr]|[Aa][Pp][Ii][-_]?[Kk][Ee][Yy]|[Pp][Rr][Ii][Vv][Aa][Tt][Ee][-_]?[Kk][Ee][Yy]|[Pp][Uu][Bb][Ll][Ii][Cc][-_]?[Kk][Ee][Yy]|[Ee][Nn][Cc][Rr][Yy][Pp][Tt][Ii][Oo][Nn][-_]?[Kk][Ee][Yy]|[Dd][Aa][Tt][Aa][-_]?[Kk][Ee][Yy]|[Ss][Ee][Ss][Ss][Ii][Oo][Nn][-_]?[Ii][Dd]|[Cc][Oo][Oo][Kk][Ii][Ee]|[Ss][Ee][Tt][-_]?[Cc][Oo][Oo][Kk][Ii][Ee]|[Cc][Ii][Pp][Hh][Ee][Rr][Tt][Ee][Xx][Tt]|[Pp][Ll][Aa][Ii][Nn][Tt][Ee][Xx][Tt]|[Ss][Ii][Gg][Nn][Aa][Tt][Uu][Rr][Ee]|[Cc][Oo][Nn][Nn][Ee][Cc][Tt][Ii][Oo][Nn][-_]?[Ss][Tt][Rr][Ii][Nn][Gg])$"
            }
          },
          "additionalProperties": {
            "$ref": "#/$defs/payloadLevel2"
          }
        }
      ]
    },
    "payloadLevel4": {
      "title": "ExecutionPayloadLevel4",
      "description": "A payload value with at most 4 further levels beneath it.",
      "anyOf": [
        {
          "type": "string",
          "maxLength": 65536
        },
        {
          "type": "number",
          "minimum": -1e+308,
          "maximum": 1e+308
        },
        {
          "type": "boolean"
        },
        {
          "type": "null"
        },
        {
          "type": "array",
          "maxItems": 256,
          "items": {
            "$ref": "#/$defs/payloadLevel3"
          }
        },
        {
          "type": "object",
          "maxProperties": 128,
          "propertyNames": {
            "maxLength": 200,
            "not": {
              "pattern": "^(?:[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Pp][Aa][Ss][Ss][Ww][Dd]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Cc][Ll][Ii][Ee][Nn][Tt][-_]?[Ss][Ee][Cc][Rr][Ee][Tt]|[Tt][Oo][Kk][Ee][Nn]|[Bb][Ee][Aa][Rr][Ee][Rr]|[Aa][Cc][Cc][Ee][Ss][Ss][-_]?[Tt][Oo][Kk][Ee][Nn]|[Rr][Ee][Ff][Rr][Ee][Ss][Hh][-_]?[Tt][Oo][Kk][Ee][Nn]|[Ii][Dd][-_]?[Tt][Oo][Kk][Ee][Nn]|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll]|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll][Ss]|[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]|[Aa][Uu][Tt][Hh][-_]?[Hh][Ee][Aa][Dd][Ee][Rr]|[Aa][Pp][Ii][-_]?[Kk][Ee][Yy]|[Pp][Rr][Ii][Vv][Aa][Tt][Ee][-_]?[Kk][Ee][Yy]|[Pp][Uu][Bb][Ll][Ii][Cc][-_]?[Kk][Ee][Yy]|[Ee][Nn][Cc][Rr][Yy][Pp][Tt][Ii][Oo][Nn][-_]?[Kk][Ee][Yy]|[Dd][Aa][Tt][Aa][-_]?[Kk][Ee][Yy]|[Ss][Ee][Ss][Ss][Ii][Oo][Nn][-_]?[Ii][Dd]|[Cc][Oo][Oo][Kk][Ii][Ee]|[Ss][Ee][Tt][-_]?[Cc][Oo][Oo][Kk][Ii][Ee]|[Cc][Ii][Pp][Hh][Ee][Rr][Tt][Ee][Xx][Tt]|[Pp][Ll][Aa][Ii][Nn][Tt][Ee][Xx][Tt]|[Ss][Ii][Gg][Nn][Aa][Tt][Uu][Rr][Ee]|[Cc][Oo][Nn][Nn][Ee][Cc][Tt][Ii][Oo][Nn][-_]?[Ss][Tt][Rr][Ii][Nn][Gg])$"
            }
          },
          "additionalProperties": {
            "$ref": "#/$defs/payloadLevel3"
          }
        }
      ]
    },
    "payloadLevel5": {
      "title": "ExecutionPayloadLevel5",
      "description": "A payload value with at most 5 further levels beneath it.",
      "anyOf": [
        {
          "type": "string",
          "maxLength": 65536
        },
        {
          "type": "number",
          "minimum": -1e+308,
          "maximum": 1e+308
        },
        {
          "type": "boolean"
        },
        {
          "type": "null"
        },
        {
          "type": "array",
          "maxItems": 256,
          "items": {
            "$ref": "#/$defs/payloadLevel4"
          }
        },
        {
          "type": "object",
          "maxProperties": 128,
          "propertyNames": {
            "maxLength": 200,
            "not": {
              "pattern": "^(?:[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Pp][Aa][Ss][Ss][Ww][Dd]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Cc][Ll][Ii][Ee][Nn][Tt][-_]?[Ss][Ee][Cc][Rr][Ee][Tt]|[Tt][Oo][Kk][Ee][Nn]|[Bb][Ee][Aa][Rr][Ee][Rr]|[Aa][Cc][Cc][Ee][Ss][Ss][-_]?[Tt][Oo][Kk][Ee][Nn]|[Rr][Ee][Ff][Rr][Ee][Ss][Hh][-_]?[Tt][Oo][Kk][Ee][Nn]|[Ii][Dd][-_]?[Tt][Oo][Kk][Ee][Nn]|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll]|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll][Ss]|[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]|[Aa][Uu][Tt][Hh][-_]?[Hh][Ee][Aa][Dd][Ee][Rr]|[Aa][Pp][Ii][-_]?[Kk][Ee][Yy]|[Pp][Rr][Ii][Vv][Aa][Tt][Ee][-_]?[Kk][Ee][Yy]|[Pp][Uu][Bb][Ll][Ii][Cc][-_]?[Kk][Ee][Yy]|[Ee][Nn][Cc][Rr][Yy][Pp][Tt][Ii][Oo][Nn][-_]?[Kk][Ee][Yy]|[Dd][Aa][Tt][Aa][-_]?[Kk][Ee][Yy]|[Ss][Ee][Ss][Ss][Ii][Oo][Nn][-_]?[Ii][Dd]|[Cc][Oo][Oo][Kk][Ii][Ee]|[Ss][Ee][Tt][-_]?[Cc][Oo][Oo][Kk][Ii][Ee]|[Cc][Ii][Pp][Hh][Ee][Rr][Tt][Ee][Xx][Tt]|[Pp][Ll][Aa][Ii][Nn][Tt][Ee][Xx][Tt]|[Ss][Ii][Gg][Nn][Aa][Tt][Uu][Rr][Ee]|[Cc][Oo][Nn][Nn][Ee][Cc][Tt][Ii][Oo][Nn][-_]?[Ss][Tt][Rr][Ii][Nn][Gg])$"
            }
          },
          "additionalProperties": {
            "$ref": "#/$defs/payloadLevel4"
          }
        }
      ]
    },
    "payloadLevel6": {
      "title": "ExecutionPayloadLevel6",
      "description": "A payload value with at most 6 further levels beneath it.",
      "anyOf": [
        {
          "type": "string",
          "maxLength": 65536
        },
        {
          "type": "number",
          "minimum": -1e+308,
          "maximum": 1e+308
        },
        {
          "type": "boolean"
        },
        {
          "type": "null"
        },
        {
          "type": "array",
          "maxItems": 256,
          "items": {
            "$ref": "#/$defs/payloadLevel5"
          }
        },
        {
          "type": "object",
          "maxProperties": 128,
          "propertyNames": {
            "maxLength": 200,
            "not": {
              "pattern": "^(?:[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Pp][Aa][Ss][Ss][Ww][Dd]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Cc][Ll][Ii][Ee][Nn][Tt][-_]?[Ss][Ee][Cc][Rr][Ee][Tt]|[Tt][Oo][Kk][Ee][Nn]|[Bb][Ee][Aa][Rr][Ee][Rr]|[Aa][Cc][Cc][Ee][Ss][Ss][-_]?[Tt][Oo][Kk][Ee][Nn]|[Rr][Ee][Ff][Rr][Ee][Ss][Hh][-_]?[Tt][Oo][Kk][Ee][Nn]|[Ii][Dd][-_]?[Tt][Oo][Kk][Ee][Nn]|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll]|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll][Ss]|[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]|[Aa][Uu][Tt][Hh][-_]?[Hh][Ee][Aa][Dd][Ee][Rr]|[Aa][Pp][Ii][-_]?[Kk][Ee][Yy]|[Pp][Rr][Ii][Vv][Aa][Tt][Ee][-_]?[Kk][Ee][Yy]|[Pp][Uu][Bb][Ll][Ii][Cc][-_]?[Kk][Ee][Yy]|[Ee][Nn][Cc][Rr][Yy][Pp][Tt][Ii][Oo][Nn][-_]?[Kk][Ee][Yy]|[Dd][Aa][Tt][Aa][-_]?[Kk][Ee][Yy]|[Ss][Ee][Ss][Ss][Ii][Oo][Nn][-_]?[Ii][Dd]|[Cc][Oo][Oo][Kk][Ii][Ee]|[Ss][Ee][Tt][-_]?[Cc][Oo][Oo][Kk][Ii][Ee]|[Cc][Ii][Pp][Hh][Ee][Rr][Tt][Ee][Xx][Tt]|[Pp][Ll][Aa][Ii][Nn][Tt][Ee][Xx][Tt]|[Ss][Ii][Gg][Nn][Aa][Tt][Uu][Rr][Ee]|[Cc][Oo][Nn][Nn][Ee][Cc][Tt][Ii][Oo][Nn][-_]?[Ss][Tt][Rr][Ii][Nn][Gg])$"
            }
          },
          "additionalProperties": {
            "$ref": "#/$defs/payloadLevel5"
          }
        }
      ]
    }
  }
} as const;

export const EmbeddingSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://contracts.ai-agent.local/execution/v1/embedding.schema.json",
  "title": "Embedding",
  "description": "A vector produced for a piece of text. The dimension is fixed, not advisory: the deployed pgvector column rejects anything else.",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "version": {
      "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/version"
    },
    "model": {
      "description": "The provider model identifier the vector came from.",
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "vector": {
      "description": "Exactly 1536 finite components.",
      "type": "array",
      "minItems": 1536,
      "maxItems": 1536,
      "items": {
        "type": "number",
        "minimum": -1e+308,
        "maximum": 1e+308
      }
    }
  },
  "required": [
    "version",
    "model",
    "vector"
  ]
} as const;

export const RuntimeStepResultSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://contracts.ai-agent.local/execution/v1/runtime-step-result.schema.json",
  "title": "RuntimeStepResult",
  "description": "What a step produced. Exactly one of three shapes, told apart by `outcome`, so a reader never has to guess which fields are meaningful.",
  "oneOf": [
    {
      "$ref": "#/$defs/final"
    },
    {
      "$ref": "#/$defs/toolRequest"
    },
    {
      "$ref": "#/$defs/failed"
    }
  ],
  "$defs": {
    "final": {
      "description": "The step finished and produced an answer.",
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "version": {
          "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/version"
        },
        "stepId": {
          "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/identifier"
        },
        "runId": {
          "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/identifier"
        },
        "attempt": {
          "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/attempt"
        },
        "outcome": {
          "const": "final"
        },
        "output": {
          "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/payload"
        },
        "artifacts": {
          "type": "array",
          "maxItems": 16,
          "items": {
            "$ref": "https://contracts.ai-agent.local/execution/v1/artifact-ref.schema.json"
          }
        }
      },
      "required": [
        "version",
        "stepId",
        "runId",
        "attempt",
        "outcome",
        "output",
        "artifacts"
      ]
    },
    "toolRequest": {
      "description": "The step wants tools run before it can finish. Still a proposal.",
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "version": {
          "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/version"
        },
        "stepId": {
          "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/identifier"
        },
        "runId": {
          "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/identifier"
        },
        "attempt": {
          "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/attempt"
        },
        "outcome": {
          "const": "tool_request"
        },
        "invocations": {
          "description": "Proposals, bounded by the same per-attempt budget the in-process tool gateway enforces.",
          "type": "array",
          "minItems": 1,
          "maxItems": 12,
          "items": {
            "$ref": "https://contracts.ai-agent.local/execution/v1/tool-invocation.schema.json"
          }
        }
      },
      "required": [
        "version",
        "stepId",
        "runId",
        "attempt",
        "outcome",
        "invocations"
      ]
    },
    "failed": {
      "description": "The step could not produce an answer.",
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "version": {
          "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/version"
        },
        "stepId": {
          "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/identifier"
        },
        "runId": {
          "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/identifier"
        },
        "attempt": {
          "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/attempt"
        },
        "outcome": {
          "const": "failed"
        },
        "failure": {
          "$ref": "https://contracts.ai-agent.local/execution/v1/safe-failure.schema.json"
        }
      },
      "required": [
        "version",
        "stepId",
        "runId",
        "attempt",
        "outcome",
        "failure"
      ]
    }
  }
} as const;

export const RuntimeStepSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://contracts.ai-agent.local/execution/v1/runtime-step.schema.json",
  "title": "RuntimeStep",
  "description": "One unit of execution, described so a worker in any language can perform it. Everything it is pinned to was decided when the run was accepted; nothing here is a question the runtime gets to answer.",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "version": {
      "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/version"
    },
    "stepId": {
      "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/identifier"
    },
    "runId": {
      "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/identifier"
    },
    "organizationId": {
      "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/identifier"
    },
    "attempt": {
      "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/attempt"
    },
    "acceptedAt": {
      "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/timestamp"
    },
    "agent": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "id": {
          "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/identifier"
        },
        "version": {
          "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/attempt"
        }
      },
      "required": [
        "id",
        "version"
      ]
    },
    "model": {
      "description": "The model pin, decided at acceptance.",
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "policyId": {
          "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/identifier"
        },
        "modelId": {
          "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/identifier"
        },
        "pricingRevisionId": {
          "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/identifier"
        }
      },
      "required": [
        "policyId",
        "modelId",
        "pricingRevisionId"
      ]
    },
    "input": {
      "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/payload"
    },
    "context": {
      "description": "Retrieved passages. The ceilings are the context policy the deployed agent definitions already use.",
      "type": "array",
      "maxItems": 12,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "documentId": {
            "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/identifier"
          },
          "chunkId": {
            "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/identifier"
          },
          "text": {
            "type": "string",
            "minLength": 1,
            "maxLength": 12000
          }
        },
        "required": [
          "documentId",
          "chunkId",
          "text"
        ]
      }
    },
    "grantedTools": {
      "description": "Tools this step may propose. A reference the Control Plane did not put here is not made usable by asking for it.",
      "type": "array",
      "maxItems": 32,
      "uniqueItems": true,
      "items": {
        "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/toolRef"
      }
    }
  },
  "required": [
    "version",
    "stepId",
    "runId",
    "organizationId",
    "attempt",
    "acceptedAt",
    "agent",
    "model",
    "input",
    "context",
    "grantedTools"
  ]
} as const;

export const SafeFailureSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://contracts.ai-agent.local/execution/v1/safe-failure.schema.json",
  "title": "SafeFailure",
  "description": "What went wrong, in terms both sides already agreed on. No stack, no raw error, no provider response: a failure crosses a trust boundary, and whatever it carries is the part an attacker gets to read.",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "version": {
      "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/version"
    },
    "code": {
      "description": "A closed vocabulary. Anything unrecognised is not a code.",
      "enum": [
        "input_rejected",
        "output_rejected",
        "contract_violation",
        "configuration_error",
        "tool_unavailable",
        "provider_unavailable",
        "provider_rejected",
        "timeout",
        "cancelled",
        "internal_error"
      ]
    },
    "retryable": {
      "description": "Whether another attempt could reach a different answer.",
      "type": "boolean"
    },
    "detail": {
      "description": "Optional bounded text written by the Control Plane for an operator. Omit it rather than sending null; never copy a provider message into it.",
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    }
  },
  "required": [
    "version",
    "code",
    "retryable"
  ]
} as const;

export const ToolInvocationSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://contracts.ai-agent.local/execution/v1/tool-invocation.schema.json",
  "title": "ToolInvocation",
  "description": "A runtime asking for a tool to be run. A proposal and nothing more: there is no field here that can carry an authorization decision, and no extra property is accepted, so a runtime cannot invent one.",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "version": {
      "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/version"
    },
    "invocationId": {
      "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/identifier"
    },
    "tool": {
      "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/toolRef"
    },
    "input": {
      "$ref": "https://contracts.ai-agent.local/execution/v1/common.schema.json#/$defs/payload"
    }
  },
  "required": [
    "version",
    "invocationId",
    "tool",
    "input"
  ]
} as const;

/** Every execution v1 document, addressed by `$id`. */
export const EXECUTION_V1_SCHEMAS: ReadonlyArray<readonly [string, object]> = [
  ["https://contracts.ai-agent.local/execution/v1/artifact-ref.schema.json", ArtifactRefSchema],
  ["https://contracts.ai-agent.local/execution/v1/common.schema.json", CommonSchema],
  ["https://contracts.ai-agent.local/execution/v1/embedding.schema.json", EmbeddingSchema],
  ["https://contracts.ai-agent.local/execution/v1/runtime-step-result.schema.json", RuntimeStepResultSchema],
  ["https://contracts.ai-agent.local/execution/v1/runtime-step.schema.json", RuntimeStepSchema],
  ["https://contracts.ai-agent.local/execution/v1/safe-failure.schema.json", SafeFailureSchema],
  ["https://contracts.ai-agent.local/execution/v1/tool-invocation.schema.json", ToolInvocationSchema],
];
