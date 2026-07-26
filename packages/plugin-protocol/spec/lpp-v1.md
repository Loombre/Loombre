# Loombre Plugin Protocol (LPP) v1

> **Generated file — do not hand-edit.** Produced by
> `pnpm --filter @loombre/plugin-protocol run generate` from
> `packages/plugin-protocol/src`. A drift check
> (`test/spec-doc-drift.spec.ts`) fails CI if this file's content
> disagrees with a fresh regeneration.
>
> This document is the FROZEN CONTRACT for LPP v1. Lanes
> W2-W5 (host core, both capability integrations, admin UI) build against
> the schemas this document describes; the schemas themselves live in
> `packages/plugin-protocol/src` and are exported for TypeScript consumers.
> JSON Schema artifacts equivalent to every schema quoted below are also
> committed at `packages/plugin-protocol/spec/schemas/lpp-v1.schemas.json`.

## 0. Status and scope

Loombre plugins are **out-of-process, versioned data contracts** — never
in-process code loading (docs/PLAN.md §4.4, pitfall P7). A plugin is any
HTTP service, in any language, that implements the endpoints this document
describes. Loombre never downloads, compiles, or executes plugin code; it
only ever sends LPP requests and receives LPP responses/deliveries over
HTTP(S).

- **C1 — process model.** Plugins are separate HTTP services. They have no
  database access, no filesystem access into the Loombre install, and no
  visibility into Loombre internals — the LPP wire surface described here
  is the entire interface.
- **C6/C7 — host-side guarantees (documented here for plugin authors).**
  Every call the host makes to a plugin carries a timeout budget; a plugin
  that repeatedly times out or errors is auto-disabled by the host's
  circuit breaker until an operator re-enables it. All outbound plugin
  traffic from the host is SSRF-guarded (the host will not be tricked into
  requesting an internal/link-local address on a plugin's behalf, and a
  plugin's own declared endpoints are validated the same way at
  registration). These behaviors are entirely host-side (lane W2) — a
  plugin author cannot configure or disable them, only design for them
  (respond promptly; a slow plugin degrades gracefully rather than wedging
  the host).
- **No telemetry.** Neither the host nor this protocol carries any
  telemetry, analytics, or phone-home mechanism. Event payloads delivered
  to an event-subscriber plugin (§4.2) are the ONLY data Loombre sends
  proactively, and only to plugins an admin has explicitly granted that
  event type to.

## 1. Transport rules

- All LPP traffic is plain HTTP or HTTPS, plugin author's choice — Loombre
  does not require a specific scheme, but SSRF-guards every outbound
  request regardless.
- Every request/response body is `application/json`, UTF-8.
- Every error response is RFC 9457 `application/problem+json` (§5).
- All timestamps are Unix epoch **milliseconds** (never seconds, never an
  ISO string) — this repository's universal timestamp convention.
- All ids crossing the LPP wire are UUIDs (host-minted ids are UUIDv7;
  see §4.2 for the one field where this matters on the wire).
- Pagination does not apply to LPP v1 — every
  request/response shape below is a single bounded exchange, not a list
  endpoint.

## 2. Manifest — `GET /lpp/manifest`

Every plugin serves this endpoint. The host calls it at registration and
whenever an admin asks it to re-check a plugin.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1
    },
    "version": {
      "type": "string",
      "minLength": 1
    },
    "protocolVersion": {
      "type": "number",
      "const": 1
    },
    "capabilities": {
      "minItems": 1,
      "type": "array",
      "items": {
        "oneOf": [
          {
            "type": "object",
            "properties": {
              "type": {
                "type": "string",
                "const": "metadata-provider"
              },
              "mediaKinds": {
                "minItems": 1,
                "type": "array",
                "items": {
                  "type": "string",
                  "enum": [
                    "movie",
                    "tv",
                    "music"
                  ]
                }
              },
              "contentClass": {
                "type": "string",
                "enum": [
                  "general",
                  "restricted"
                ]
              },
              "endpoints": {
                "type": "object",
                "properties": {
                  "search": {
                    "type": "string",
                    "pattern": "^\\/(?![/\\\\])"
                  },
                  "details": {
                    "type": "string",
                    "pattern": "^\\/(?![/\\\\])"
                  },
                  "images": {
                    "type": "string",
                    "pattern": "^\\/(?![/\\\\])"
                  }
                },
                "required": [
                  "search",
                  "details",
                  "images"
                ],
                "additionalProperties": false
              }
            },
            "required": [
              "type",
              "mediaKinds",
              "contentClass",
              "endpoints"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "type": {
                "type": "string",
                "const": "event-subscriber"
              },
              "eventTypes": {
                "minItems": 1,
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "delivery": {
                "type": "object",
                "properties": {
                  "endpoint": {
                    "type": "string",
                    "pattern": "^\\/(?![/\\\\])"
                  }
                },
                "required": [
                  "endpoint"
                ],
                "additionalProperties": false
              },
              "contentClass": {
                "type": "string",
                "enum": [
                  "general",
                  "restricted"
                ]
              }
            },
            "required": [
              "type",
              "eventTypes",
              "delivery",
              "contentClass"
            ],
            "additionalProperties": false
          }
        ]
      }
    },
    "configSchema": {
      "$ref": "#/$defs/__schema0"
    },
    "description": {
      "type": "string",
      "minLength": 1
    },
    "publisher": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "name",
    "version",
    "protocolVersion",
    "capabilities",
    "configSchema",
    "description",
    "publisher"
  ],
  "additionalProperties": false,
  "$defs": {
    "__schema0": {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "const": "object"
        },
        "description": {
          "type": "string",
          "minLength": 1
        },
        "properties": {
          "type": "object",
          "propertyNames": {
            "type": "string"
          },
          "additionalProperties": {
            "$ref": "#/$defs/__schema1"
          }
        },
        "required": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "additionalProperties": {
          "type": "boolean",
          "const": false
        }
      },
      "required": [
        "type",
        "properties",
        "additionalProperties"
      ],
      "additionalProperties": false
    },
    "__schema1": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "string"
            },
            "description": {
              "type": "string",
              "minLength": 1
            },
            "enum": {
              "minItems": 1,
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "const": {
              "type": "string"
            },
            "minLength": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "maxLength": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "default": {
              "type": "string"
            },
            "secret": {
              "type": "boolean"
            }
          },
          "required": [
            "type"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "enum": [
                "number",
                "integer"
              ]
            },
            "description": {
              "type": "string",
              "minLength": 1
            },
            "minimum": {
              "type": "number"
            },
            "maximum": {
              "type": "number"
            },
            "default": {
              "type": "number"
            }
          },
          "required": [
            "type"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "boolean"
            },
            "description": {
              "type": "string",
              "minLength": 1
            },
            "default": {
              "type": "boolean"
            }
          },
          "required": [
            "type"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "array"
            },
            "description": {
              "type": "string",
              "minLength": 1
            },
            "items": {
              "$ref": "#/$defs/__schema1"
            },
            "minItems": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "maxItems": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "type",
            "items"
          ],
          "additionalProperties": false
        },
        {
          "$ref": "#/$defs/__schema0"
        }
      ]
    }
  }
}
```


- `protocolVersion` MUST equal `1` for this document's
  schemas to apply. A host that only speaks LPP v1
  rejects any other value at registration with a clear "unsupported
  protocolVersion" error — see §6 (versioning policy) for what happens when
  a v2 exists.
- `capabilities` is a **discriminated union** keyed on `type`. An entry
  whose `type` the host does not recognize is REJECTED at registration
  with a clear "this Loombre doesn't support capability type `<type>` yet"
  error — it is
  never silently ignored, and it never prevents the OTHER, recognized
  capabilities in the same manifest from registering (this package's
  `parseLppCapabilities` reports per-entry results precisely so a host can
  make that distinction).
- **At most ONE entry per capability `type`** (erratum, adversarial-review
  fix wave, finding C-1). A manifest declaring the same `type` twice is
  REJECTED wholesale at parse time with a "declared more than once" error —
  this is a narrowing of the frozen contract (the original v1 spec was
  silent on duplicates), adopted because nothing in a real host can
  meaningfully resolve which of two same-typed entries governs it, and a
  host that picked inconsistently between two different code paths (e.g.
  "the first entry" vs. "any matching entry") could be made to silently
  disagree with itself about a plugin's effective scope.
- `configSchema` is always present, even for a plugin with no configurable
  fields (`{ "type": "object", "properties": {}, "additionalProperties":
  false }`). Its shape, INCLUDING two additional structural bounds adopted
  in the same fix wave (finding M-2), is documented in §3.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "const": "metadata-provider"
        },
        "mediaKinds": {
          "minItems": 1,
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "movie",
              "tv",
              "music"
            ]
          }
        },
        "contentClass": {
          "type": "string",
          "enum": [
            "general",
            "restricted"
          ]
        },
        "endpoints": {
          "type": "object",
          "properties": {
            "search": {
              "type": "string",
              "pattern": "^\\/(?![/\\\\])"
            },
            "details": {
              "type": "string",
              "pattern": "^\\/(?![/\\\\])"
            },
            "images": {
              "type": "string",
              "pattern": "^\\/(?![/\\\\])"
            }
          },
          "required": [
            "search",
            "details",
            "images"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "type",
        "mediaKinds",
        "contentClass",
        "endpoints"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "const": "event-subscriber"
        },
        "eventTypes": {
          "minItems": 1,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "delivery": {
          "type": "object",
          "properties": {
            "endpoint": {
              "type": "string",
              "pattern": "^\\/(?![/\\\\])"
            }
          },
          "required": [
            "endpoint"
          ],
          "additionalProperties": false
        },
        "contentClass": {
          "type": "string",
          "enum": [
            "general",
            "restricted"
          ]
        }
      },
      "required": [
        "type",
        "eventTypes",
        "delivery",
        "contentClass"
      ],
      "additionalProperties": false
    }
  ]
}
```


## 3. Config & secrets

`configSchema` uses the same JSON-Schema subset and conventions as
Loombre's own admin-settings registry (`packages/shared/src/settings-
registry.ts`'s `z.toJSONSchema` projection, Addendum A/AD3): `string`,
`number`/`integer` (optionally bounded by `minimum`/`maximum`), `boolean`,
string `enum`, `array` (of one nested level), and `object`
(`properties`/`required`/`additionalProperties: false`) — no
`oneOf`/`anyOf`/`$ref`. One LPP-specific extension keyword is layered on
top: a `type: "string"` field may carry `"secret": true`, meaning its
value is stored in the host's keyring rather than in plain admin-settings
storage — **only at the TOP LEVEL** of `configSchema.properties` (erratum,
adversarial-review fix wave, finding H-1): the header encoding below has no
representation for a secret value nested inside the single `X-LPP-Config`
JSON object, so a manifest declaring `"secret": true` on a field nested
inside an `object`'s `properties` or an `array`'s `items`, at any depth, is
REJECTED at parse time. This is schema-legal-but-meaningless in the
original v1 spec's silence on placement; the frozen contract now says so
explicitly.

Two structural bounds also apply to the WHOLE `configSchema` tree (erratum,
same fix wave, finding M-2), enforced at parse time as a typed rejection —
never an unbounded recursive walk: nesting depth is capped at 8 levels, and
any single `enum`/`properties`/`required` list is capped at 200 entries.
Both are generous relative to the settings-registry vocabulary this schema
mirrors; no legitimate plugin config form needs more.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "object"
    },
    "description": {
      "type": "string",
      "minLength": 1
    },
    "properties": {
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {
        "$ref": "#/$defs/__schema0"
      }
    },
    "required": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "additionalProperties": {
      "type": "boolean",
      "const": false
    }
  },
  "required": [
    "type",
    "properties",
    "additionalProperties"
  ],
  "additionalProperties": false,
  "$defs": {
    "__schema0": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "string"
            },
            "description": {
              "type": "string",
              "minLength": 1
            },
            "enum": {
              "minItems": 1,
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "const": {
              "type": "string"
            },
            "minLength": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "maxLength": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "default": {
              "type": "string"
            },
            "secret": {
              "type": "boolean"
            }
          },
          "required": [
            "type"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "enum": [
                "number",
                "integer"
              ]
            },
            "description": {
              "type": "string",
              "minLength": 1
            },
            "minimum": {
              "type": "number"
            },
            "maximum": {
              "type": "number"
            },
            "default": {
              "type": "number"
            }
          },
          "required": [
            "type"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "boolean"
            },
            "description": {
              "type": "string",
              "minLength": 1
            },
            "default": {
              "type": "boolean"
            }
          },
          "required": [
            "type"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "array"
            },
            "description": {
              "type": "string",
              "minLength": 1
            },
            "items": {
              "$ref": "#/$defs/__schema0"
            },
            "minItems": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "maxItems": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "type",
            "items"
          ],
          "additionalProperties": false
        },
        {
          "$ref": "#"
        }
      ]
    }
  }
}
```


The host renders `configSchema` into the plugin's admin config form.
Whenever the host calls a plugin, it resolves that plugin's current config
values and injects them **per request**, via headers, so plugins remain
stateless (a stolen plugin container holds no keys):

- `X-LPP-Config`: every NON-secret field, as one JSON object, encoded
  `base64(utf8(JSON.stringify(configObject)))`.
- `X-LPP-Secret-<NAME>`: one header per `secret: true` field, encoded
  `base64(utf8(secretStringValue))`. `<NAME>` is the field's own
  configSchema property key, canonicalized to an HTTP header token
  (uppercased; any character outside `RFC 7230` `token` grammar collapsed
  to `-`).

Both use base64 of the UTF-8 bytes specifically because HTTP header values
are not safe for arbitrary text (RFC 9110 §5.5) — a config value or secret
containing non-ASCII characters (accented names, emoji in a message
template, etc.) would otherwise be mangled or rejected by an intermediary.
Base64's alphabet is pure ASCII, so the encoded header value is always
legal regardless of what the original text contained.

## 4. Capabilities

### 4.1 `metadata-provider`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "metadata-provider"
    },
    "mediaKinds": {
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "movie",
          "tv",
          "music"
        ]
      }
    },
    "contentClass": {
      "type": "string",
      "enum": [
        "general",
        "restricted"
      ]
    },
    "endpoints": {
      "type": "object",
      "properties": {
        "search": {
          "type": "string",
          "pattern": "^\\/(?![/\\\\])"
        },
        "details": {
          "type": "string",
          "pattern": "^\\/(?![/\\\\])"
        },
        "images": {
          "type": "string",
          "pattern": "^\\/(?![/\\\\])"
        }
      },
      "required": [
        "search",
        "details",
        "images"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "type",
    "mediaKinds",
    "contentClass",
    "endpoints"
  ],
  "additionalProperties": false
}
```


`endpoints.*` paths (and `event-subscriber`'s `delivery.endpoint`, §4.2)
must start with `/` and MUST NOT begin `//` or `/\\` (erratum,
adversarial-review fix wave, finding H-5) — WHATWG URL resolution
(`new URL(path, baseUrl)`, exactly how a host turns a declared path into a
request target) treats either leading form as an AUTHORITY, not a path,
which would silently redirect the call to an arbitrary third-party host
chosen by the path string alone, off the plugin's own registered
`baseUrl`. Hosts additionally verify `resolved.origin === baseUrl.origin`
after resolution as a second, independent check.

Default endpoint paths (a manifest may declare different paths; every
reference/example plugin in this repository uses these verbatim):

```json
{
  "search": "/lpp/provider/search",
  "details": "/lpp/provider/details",
  "images": "/lpp/provider/images"
}
```


These wire shapes mirror the INTERNAL metadata-provider interface
(`apps/worker/src/metadata/provider.ts`'s `search`/`fetchDetails`/
`fetchImages`, with TMDB/TVDB/MusicBrainz as the built-in implementations)
field-for-field, so a host adapter maps a wire response onto that interface
with no lossy translation in either direction.

#### `POST <endpoints.search>`

Request:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "mediaKind": {
      "type": "string",
      "enum": [
        "movie",
        "tv",
        "music"
      ]
    },
    "title": {
      "type": "string",
      "minLength": 1
    },
    "year": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9999
        },
        {
          "type": "null"
        }
      ]
    },
    "entityKind": {
      "type": "string",
      "enum": [
        "artist",
        "album",
        "track"
      ]
    }
  },
  "required": [
    "mediaKind",
    "title"
  ],
  "additionalProperties": false
}
```


Response:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "results": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "ref": {
            "type": "object",
            "properties": {
              "provider": {
                "type": "string",
                "minLength": 1
              },
              "externalId": {
                "type": "string",
                "minLength": 1
              },
              "mediaKind": {
                "type": "string",
                "enum": [
                  "movie",
                  "tv",
                  "music"
                ]
              },
              "seasonNumber": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "episodeNumber": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "entityKind": {
                "type": "string",
                "enum": [
                  "artist",
                  "album",
                  "track"
                ]
              }
            },
            "required": [
              "provider",
              "externalId",
              "mediaKind"
            ],
            "additionalProperties": false
          },
          "title": {
            "type": "string",
            "minLength": 1
          },
          "year": {
            "anyOf": [
              {
                "type": "integer",
                "minimum": 0,
                "maximum": 9999
              },
              {
                "type": "null"
              }
            ]
          },
          "overview": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "popularity": {
            "anyOf": [
              {
                "type": "number"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "ref",
          "title"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "results"
  ],
  "additionalProperties": false
}
```


#### `POST <endpoints.details>`

Request:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "ref": {
      "type": "object",
      "properties": {
        "provider": {
          "type": "string",
          "minLength": 1
        },
        "externalId": {
          "type": "string",
          "minLength": 1
        },
        "mediaKind": {
          "type": "string",
          "enum": [
            "movie",
            "tv",
            "music"
          ]
        },
        "seasonNumber": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            {
              "type": "null"
            }
          ]
        },
        "episodeNumber": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            {
              "type": "null"
            }
          ]
        },
        "entityKind": {
          "type": "string",
          "enum": [
            "artist",
            "album",
            "track"
          ]
        }
      },
      "required": [
        "provider",
        "externalId",
        "mediaKind"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "ref"
  ],
  "additionalProperties": false
}
```


Response (`details` is a discriminated union on `itemType` — one variant
per catalog item type: `movie`, `series`, `season`, `episode`, `artist`,
`album`, `track`):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "details": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "title": {
              "type": "string",
              "minLength": 1
            },
            "sortTitle": {
              "type": "string",
              "minLength": 1
            },
            "year": {
              "anyOf": [
                {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9999
                },
                {
                  "type": "null"
                }
              ]
            },
            "overview": {
              "anyOf": [
                {
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ]
            },
            "communityRating": {
              "anyOf": [
                {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 10
                },
                {
                  "type": "null"
                }
              ]
            },
            "contentRating": {
              "anyOf": [
                {
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ]
            },
            "genres": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "tags": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "people": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "name": {
                    "type": "string",
                    "minLength": 1
                  },
                  "role": {
                    "type": "string",
                    "enum": [
                      "actor",
                      "director",
                      "writer",
                      "artist",
                      "album_artist",
                      "performer",
                      "guest"
                    ]
                  },
                  "order": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "credit": {
                    "anyOf": [
                      {
                        "type": "string"
                      },
                      {
                        "type": "null"
                      }
                    ]
                  }
                },
                "required": [
                  "name",
                  "role",
                  "order"
                ],
                "additionalProperties": false
              }
            },
            "providerIds": {
              "type": "object",
              "propertyNames": {
                "type": "string"
              },
              "additionalProperties": {
                "type": "string"
              }
            },
            "itemType": {
              "type": "string",
              "const": "movie"
            },
            "tagline": {
              "anyOf": [
                {
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ]
            },
            "runtimeMs": {
              "anyOf": [
                {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                {
                  "type": "null"
                }
              ]
            }
          },
          "required": [
            "title",
            "sortTitle",
            "year",
            "overview",
            "communityRating",
            "contentRating",
            "genres",
            "tags",
            "people",
            "providerIds",
            "itemType",
            "tagline",
            "runtimeMs"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "title": {
              "type": "string",
              "minLength": 1
            },
            "sortTitle": {
              "type": "string",
              "minLength": 1
            },
            "year": {
              "anyOf": [
                {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9999
                },
                {
                  "type": "null"
                }
              ]
            },
            "overview": {
              "anyOf": [
                {
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ]
            },
            "communityRating": {
              "anyOf": [
                {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 10
                },
                {
                  "type": "null"
                }
              ]
            },
            "contentRating": {
              "anyOf": [
                {
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ]
            },
            "genres": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "tags": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "people": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "name": {
                    "type": "string",
                    "minLength": 1
                  },
                  "role": {
                    "type": "string",
                    "enum": [
                      "actor",
                      "director",
                      "writer",
                      "artist",
                      "album_artist",
                      "performer",
                      "guest"
                    ]
                  },
                  "order": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "credit": {
                    "anyOf": [
                      {
                        "type": "string"
                      },
                      {
                        "type": "null"
                      }
                    ]
                  }
                },
                "required": [
                  "name",
                  "role",
                  "order"
                ],
                "additionalProperties": false
              }
            },
            "providerIds": {
              "type": "object",
              "propertyNames": {
                "type": "string"
              },
              "additionalProperties": {
                "type": "string"
              }
            },
            "itemType": {
              "type": "string",
              "const": "series"
            },
            "status": {
              "anyOf": [
                {
                  "type": "string",
                  "enum": [
                    "continuing",
                    "ended",
                    "cancelled"
                  ]
                },
                {
                  "type": "null"
                }
              ]
            },
            "airDateMs": {
              "anyOf": [
                {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                {
                  "type": "null"
                }
              ]
            }
          },
          "required": [
            "title",
            "sortTitle",
            "year",
            "overview",
            "communityRating",
            "contentRating",
            "genres",
            "tags",
            "people",
            "providerIds",
            "itemType",
            "status",
            "airDateMs"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "title": {
              "type": "string",
              "minLength": 1
            },
            "sortTitle": {
              "type": "string",
              "minLength": 1
            },
            "year": {
              "anyOf": [
                {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9999
                },
                {
                  "type": "null"
                }
              ]
            },
            "overview": {
              "anyOf": [
                {
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ]
            },
            "communityRating": {
              "anyOf": [
                {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 10
                },
                {
                  "type": "null"
                }
              ]
            },
            "contentRating": {
              "anyOf": [
                {
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ]
            },
            "genres": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "tags": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "people": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "name": {
                    "type": "string",
                    "minLength": 1
                  },
                  "role": {
                    "type": "string",
                    "enum": [
                      "actor",
                      "director",
                      "writer",
                      "artist",
                      "album_artist",
                      "performer",
                      "guest"
                    ]
                  },
                  "order": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "credit": {
                    "anyOf": [
                      {
                        "type": "string"
                      },
                      {
                        "type": "null"
                      }
                    ]
                  }
                },
                "required": [
                  "name",
                  "role",
                  "order"
                ],
                "additionalProperties": false
              }
            },
            "providerIds": {
              "type": "object",
              "propertyNames": {
                "type": "string"
              },
              "additionalProperties": {
                "type": "string"
              }
            },
            "itemType": {
              "type": "string",
              "const": "season"
            },
            "seasonNumber": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "title",
            "sortTitle",
            "year",
            "overview",
            "communityRating",
            "contentRating",
            "genres",
            "tags",
            "people",
            "providerIds",
            "itemType",
            "seasonNumber"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "title": {
              "type": "string",
              "minLength": 1
            },
            "sortTitle": {
              "type": "string",
              "minLength": 1
            },
            "year": {
              "anyOf": [
                {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9999
                },
                {
                  "type": "null"
                }
              ]
            },
            "overview": {
              "anyOf": [
                {
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ]
            },
            "communityRating": {
              "anyOf": [
                {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 10
                },
                {
                  "type": "null"
                }
              ]
            },
            "contentRating": {
              "anyOf": [
                {
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ]
            },
            "genres": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "tags": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "people": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "name": {
                    "type": "string",
                    "minLength": 1
                  },
                  "role": {
                    "type": "string",
                    "enum": [
                      "actor",
                      "director",
                      "writer",
                      "artist",
                      "album_artist",
                      "performer",
                      "guest"
                    ]
                  },
                  "order": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "credit": {
                    "anyOf": [
                      {
                        "type": "string"
                      },
                      {
                        "type": "null"
                      }
                    ]
                  }
                },
                "required": [
                  "name",
                  "role",
                  "order"
                ],
                "additionalProperties": false
              }
            },
            "providerIds": {
              "type": "object",
              "propertyNames": {
                "type": "string"
              },
              "additionalProperties": {
                "type": "string"
              }
            },
            "itemType": {
              "type": "string",
              "const": "episode"
            },
            "seasonNumber": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "episodeNumber": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "airDateMs": {
              "anyOf": [
                {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                {
                  "type": "null"
                }
              ]
            }
          },
          "required": [
            "title",
            "sortTitle",
            "year",
            "overview",
            "communityRating",
            "contentRating",
            "genres",
            "tags",
            "people",
            "providerIds",
            "itemType",
            "seasonNumber",
            "episodeNumber",
            "airDateMs"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "title": {
              "type": "string",
              "minLength": 1
            },
            "sortTitle": {
              "type": "string",
              "minLength": 1
            },
            "year": {
              "anyOf": [
                {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9999
                },
                {
                  "type": "null"
                }
              ]
            },
            "overview": {
              "anyOf": [
                {
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ]
            },
            "communityRating": {
              "anyOf": [
                {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 10
                },
                {
                  "type": "null"
                }
              ]
            },
            "contentRating": {
              "anyOf": [
                {
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ]
            },
            "genres": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "tags": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "people": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "name": {
                    "type": "string",
                    "minLength": 1
                  },
                  "role": {
                    "type": "string",
                    "enum": [
                      "actor",
                      "director",
                      "writer",
                      "artist",
                      "album_artist",
                      "performer",
                      "guest"
                    ]
                  },
                  "order": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "credit": {
                    "anyOf": [
                      {
                        "type": "string"
                      },
                      {
                        "type": "null"
                      }
                    ]
                  }
                },
                "required": [
                  "name",
                  "role",
                  "order"
                ],
                "additionalProperties": false
              }
            },
            "providerIds": {
              "type": "object",
              "propertyNames": {
                "type": "string"
              },
              "additionalProperties": {
                "type": "string"
              }
            },
            "itemType": {
              "type": "string",
              "const": "artist"
            }
          },
          "required": [
            "title",
            "sortTitle",
            "year",
            "overview",
            "communityRating",
            "contentRating",
            "genres",
            "tags",
            "people",
            "providerIds",
            "itemType"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "title": {
              "type": "string",
              "minLength": 1
            },
            "sortTitle": {
              "type": "string",
              "minLength": 1
            },
            "year": {
              "anyOf": [
                {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9999
                },
                {
                  "type": "null"
                }
              ]
            },
            "overview": {
              "anyOf": [
                {
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ]
            },
            "communityRating": {
              "anyOf": [
                {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 10
                },
                {
                  "type": "null"
                }
              ]
            },
            "contentRating": {
              "anyOf": [
                {
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ]
            },
            "genres": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "tags": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "people": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "name": {
                    "type": "string",
                    "minLength": 1
                  },
                  "role": {
                    "type": "string",
                    "enum": [
                      "actor",
                      "director",
                      "writer",
                      "artist",
                      "album_artist",
                      "performer",
                      "guest"
                    ]
                  },
                  "order": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "credit": {
                    "anyOf": [
                      {
                        "type": "string"
                      },
                      {
                        "type": "null"
                      }
                    ]
                  }
                },
                "required": [
                  "name",
                  "role",
                  "order"
                ],
                "additionalProperties": false
              }
            },
            "providerIds": {
              "type": "object",
              "propertyNames": {
                "type": "string"
              },
              "additionalProperties": {
                "type": "string"
              }
            },
            "itemType": {
              "type": "string",
              "const": "album"
            }
          },
          "required": [
            "title",
            "sortTitle",
            "year",
            "overview",
            "communityRating",
            "contentRating",
            "genres",
            "tags",
            "people",
            "providerIds",
            "itemType"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "title": {
              "type": "string",
              "minLength": 1
            },
            "sortTitle": {
              "type": "string",
              "minLength": 1
            },
            "year": {
              "anyOf": [
                {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9999
                },
                {
                  "type": "null"
                }
              ]
            },
            "overview": {
              "anyOf": [
                {
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ]
            },
            "communityRating": {
              "anyOf": [
                {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 10
                },
                {
                  "type": "null"
                }
              ]
            },
            "contentRating": {
              "anyOf": [
                {
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ]
            },
            "genres": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "tags": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "people": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "name": {
                    "type": "string",
                    "minLength": 1
                  },
                  "role": {
                    "type": "string",
                    "enum": [
                      "actor",
                      "director",
                      "writer",
                      "artist",
                      "album_artist",
                      "performer",
                      "guest"
                    ]
                  },
                  "order": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "credit": {
                    "anyOf": [
                      {
                        "type": "string"
                      },
                      {
                        "type": "null"
                      }
                    ]
                  }
                },
                "required": [
                  "name",
                  "role",
                  "order"
                ],
                "additionalProperties": false
              }
            },
            "providerIds": {
              "type": "object",
              "propertyNames": {
                "type": "string"
              },
              "additionalProperties": {
                "type": "string"
              }
            },
            "itemType": {
              "type": "string",
              "const": "track"
            },
            "trackNumber": {
              "anyOf": [
                {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                {
                  "type": "null"
                }
              ]
            },
            "discNumber": {
              "anyOf": [
                {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                {
                  "type": "null"
                }
              ]
            },
            "durationMs": {
              "anyOf": [
                {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                {
                  "type": "null"
                }
              ]
            }
          },
          "required": [
            "title",
            "sortTitle",
            "year",
            "overview",
            "communityRating",
            "contentRating",
            "genres",
            "tags",
            "people",
            "providerIds",
            "itemType",
            "trackNumber",
            "discNumber",
            "durationMs"
          ],
          "additionalProperties": false
        }
      ]
    }
  },
  "required": [
    "details"
  ],
  "additionalProperties": false
}
```


#### `POST <endpoints.images>`

Request:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "ref": {
      "type": "object",
      "properties": {
        "provider": {
          "type": "string",
          "minLength": 1
        },
        "externalId": {
          "type": "string",
          "minLength": 1
        },
        "mediaKind": {
          "type": "string",
          "enum": [
            "movie",
            "tv",
            "music"
          ]
        },
        "seasonNumber": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            {
              "type": "null"
            }
          ]
        },
        "episodeNumber": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            {
              "type": "null"
            }
          ]
        },
        "entityKind": {
          "type": "string",
          "enum": [
            "artist",
            "album",
            "track"
          ]
        }
      },
      "required": [
        "provider",
        "externalId",
        "mediaKind"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "ref"
  ],
  "additionalProperties": false
}
```


Response:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "images": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "kind": {
            "type": "string",
            "enum": [
              "poster",
              "backdrop",
              "logo",
              "disc",
              "thumb"
            ]
          },
          "url": {
            "type": "string",
            "minLength": 1
          },
          "width": {
            "anyOf": [
              {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              {
                "type": "null"
              }
            ]
          },
          "height": {
            "anyOf": [
              {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "kind",
          "url"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "images"
  ],
  "additionalProperties": false
}
```


Image URLs are absolute and fetchable — the host's image pipeline downloads
them directly; a provider never returns image bytes inline (docs/PLAN.md
§8.3).

### 4.2 `event-subscriber`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "event-subscriber"
    },
    "eventTypes": {
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1
      }
    },
    "delivery": {
      "type": "object",
      "properties": {
        "endpoint": {
          "type": "string",
          "pattern": "^\\/(?![/\\\\])"
        }
      },
      "required": [
        "endpoint"
      ],
      "additionalProperties": false
    },
    "contentClass": {
      "type": "string",
      "enum": [
        "general",
        "restricted"
      ]
    }
  },
  "required": [
    "type",
    "eventTypes",
    "delivery",
    "contentClass"
  ],
  "additionalProperties": false
}
```


- `eventTypes` on the manifest is a **request**: the set of outbox event
  types (docs/PLAN.md §4.3) the plugin wants. The host validates each
  against its published outbox taxonomy at registration and an admin
  GRANTS registration with possibly **fewer** event types than requested —
  the granted set is host state, not part of this wire schema. A plugin
  discovers what it actually receives by inspecting each delivered batch,
  never by re-reading its own manifest. In LPP v1, a
  host's published outbox taxonomy EXCLUDES every event type it classifies
  as instance-administration-only (a plugin registering, a plugin's own
  config changing, a server setting changing, and similar — the exact same
  set a logged-in NON-ADMIN user is never shown over the equivalent
  human-facing live-event channel) — requesting one of these is rejected
  exactly like requesting a type the host does not publish at all.
- `contentClass` scopes which events reach this subscriber, the same way
  it scopes a metadata-provider's catalog visibility (capability-uniform
  content-class scoping) — a `'general'`-scoped subscriber never receives
  an event concerning restricted-content items.

Default delivery path:

```json
{
  "endpoint": "/lpp/events"
}
```


#### Delivery mechanics

- **At-least-once, batched.** The host keeps one delivery cursor per
  plugin; a batch may be redelivered after a prior delivery that the host
  could not confirm was acknowledged. Plugins MUST be idempotent per event
  `id`.
- **Acknowledgement is implicit.** Any `2xx` response to
  `POST <delivery.endpoint>` acks the whole batch. There is no separate ack
  message.
- **Gaps are reported, never silently skipped.** If a plugin was
  unreachable longer than the host's outbox retention window, the next
  batch's `gapReport` field is populated describing the gap; when there is
  no gap, `gapReport` is `null` (always present, never omitted).
- **Actor pseudonymization.** Actor ids inside an event `payload` may be
  pseudonymized by the host (the default) — subscribers MUST NOT assume any
  id in a payload is a real user id.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "batchId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "events": {
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
          },
          "type": {
            "type": "string",
            "minLength": 1
          },
          "occurredAtMs": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "payload": {
            "type": "object",
            "propertyNames": {
              "type": "string"
            },
            "additionalProperties": {}
          }
        },
        "required": [
          "id",
          "type",
          "occurredAtMs",
          "payload"
        ],
        "additionalProperties": false
      }
    },
    "gapReport": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "detectedAtMs": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "gaps": {
              "minItems": 1,
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "fromMs": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "toMs": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "reason": {
                    "type": "string",
                    "minLength": 1
                  }
                },
                "required": [
                  "fromMs",
                  "toMs",
                  "reason"
                ],
                "additionalProperties": false
              }
            }
          },
          "required": [
            "detectedAtMs",
            "gaps"
          ],
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "batchId",
    "events",
    "gapReport"
  ],
  "additionalProperties": false
}
```


#### Delivery signing

Every delivery carries:

```
X-LPP-Signature: t=<unix-ms>,v1=<hex hmac-sha256 of "<t>.<raw body>">
```

The secret is minted per-plugin at registration (host-side, lane W2) and,
per this protocol's design, is provisioned to the plugin **out-of-band**
(shown once at registration, the same convention Stripe/GitHub webhook
signing secrets use) rather than re-delivered on every request — the
signature exists to authenticate the SENDER of an inbound delivery, a
different trust concern from the plugin's own `configSchema` secrets
(§3), which genuinely must be re-injected per request because the plugin
never persists them.

Verification pseudocode (a subscriber MUST perform this check before
trusting a batch):

```
function verify(headerValue, secret, rawBody, nowMs, replayWindowMs):
    if headerValue is absent:
        reject("missing-header")
    (t, v1) = parse "t=<ms>,v1=<hex>" from headerValue
    if parse fails:
        reject("malformed-header")
    expected = hex(hmacSha256(secret, `${t}.${rawBody}`))
    if not constantTimeEqual(expected, v1):
        reject("signature-mismatch")
    if abs(nowMs - t) > replayWindowMs:
        reject(nowMs - t > replayWindowMs ? "stale-timestamp" : "future-timestamp")
    accept()
```

Signature verification (`signature-mismatch`) is a **MUST**. Enforcing the
replay window (`stale-timestamp`/`future-timestamp`) is a **SHOULD** — the
conformance suite (§7) reports a plugin that skips it as a `warn`, not a
`fail`, but every reference plugin in this repository enforces it. The
default replay window is 300000 ms (5 minutes).

## 5. Error model

Every non-2xx LPP response is RFC 9457 `application/problem+json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "type": {
      "default": "about:blank",
      "type": "string",
      "minLength": 1
    },
    "title": {
      "type": "string",
      "minLength": 1
    },
    "status": {
      "type": "integer",
      "minimum": 100,
      "maximum": 599
    },
    "detail": {
      "type": "string"
    },
    "instance": {
      "type": "string"
    },
    "code": {
      "type": "string"
    }
  },
  "required": [
    "type",
    "title",
    "status"
  ],
  "additionalProperties": {}
}
```


LPP defines its own `type` URN catalog, independent of the main Loombre
API's `urn:loombre:problem:*` catalog (plugins are third-party,
out-of-process services, not part of the main API surface):

```json
{
  "validation": "urn:loombre:lpp:problem:validation",
  "notFound": "urn:loombre:lpp:problem:not-found",
  "invalidSignature": "urn:loombre:lpp:problem:invalid-signature",
  "staleTimestamp": "urn:loombre:lpp:problem:stale-timestamp"
}
```


This catalog is additive-only: a future LPP release may add new `type`
values, never repurpose an existing one.

## 6. Versioning policy

LPP v1 is **additive-only** (C8): every schema in this
document may grow new OPTIONAL members over time without a version bump. A
genuinely breaking change requires a new protocol version — a future LPP v2
would be a sibling module (its own `version.ts`, its own schemas), running
BESIDE v1, not a replacement for it. A plugin declares the single protocol
version it speaks via `protocolVersion` in its manifest; a host that speaks
multiple LPP versions negotiates by reading that field at registration and
routing the plugin to the matching version's request/response handling.
New capability types (`Capability`'s discriminated union) are the
additive extension point for entirely new plugin behaviors — adding one
never changes the manifest envelope itself (§2).

## 7. Conformance

`packages/plugin-protocol` ships a conformance suite runnable as:

```
pnpm lpp:conform <url> [--secret <hex>] [--config <json>] [--secret-field NAME=value]
```

It fetches `GET /lpp/manifest`, validates the envelope and
`protocolVersion`, then — for each capability the manifest declares — runs
that capability's suite (schema-valid round-trips for `metadata-provider`;
signed test-batch delivery for `event-subscriber`). It prints a
human-readable pass/warn/fail report and exits non-zero iff any check
failed. Two reference plugins in this repository
(`examples/lpp-reference-provider`, `examples/lpp-discord-notifier`) pass
it in full, and `test/integration.spec.ts` in this package exercises that
as its own automated proof.
