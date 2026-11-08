# Enforcing Solder's settings (Group Policy and Intune)

An organization can set any of Solder's settings for its users and lock them, with Group Policy or Intune. The
gateway address is the one most will want. Every user still sets their own API key: keys are never set by policy.

## How it works

Solder reads two registry keys, both writable only by administrators:

| Key | Applies to |
|---|---|
| `HKLM\SOFTWARE\Policies\Gremnar\Solder` | every user of the PC (computer policy) |
| `HKCU\SOFTWARE\Policies\Gremnar\Solder` | one user (user policy) |

- **A value that's there is enforced.** Solder uses it, ignores the user's own setting, and shows the field locked
  in its settings, marked "Set by your organization". A value that isn't there leaves that setting to the user.
- **Computer policy wins over user policy,** value by value.
- **When it's read:** when VS Code starts Solder, when Solder's settings are opened, and every 30 minutes.
- **If the keys can't be read** (`reg.exe` is blocked, say), Solder doesn't connect until they can be. It fails
  closed, so an enforced gateway can't be bypassed.

## The values

| Value | Type | What it does |
|---|---|---|
| `Endpoint` | REG_SZ | The gateway's Chat Completions URL, ending in `/chat/completions`. If it isn't valid, Solder won't connect (it doesn't fall back to the user's). |
| `Model` | REG_SZ | The model id. Users can't pick another, for new chats or existing ones. |
| `ModelFilter` | REG_SZ | A regular expression: only matching model ids are offered. |
| `ModelNames` | REG_SZ | Short names for the picker, as JSON: `{"model-a": "Model A"}`. |
| `Effort` | REG_SZ | `default`, `low`, `medium` or `high`. Users can't change it, in settings or per chat. |
| `DocsFolders` | REG_MULTI_SZ | Docs folders, one per line, each optionally followed by `\|` and a note on what's in it: `\\fileserver\docs\api\|The API reference`. |
| `AllowUserDocsFolders` | REG_DWORD | With `DocsFolders` set: `1` lets users add folders of their own beside the organization's; `0` or absent, only the organization's. |
| `DocsSearch` | REG_SZ | `keyword` or `hybrid` (keywords and meaning). Enforce `keyword` to keep docs text from being sent for embedding. |
| `EmbeddingModel` | REG_SZ | The gateway's embeddings model, for search by meaning. |
| `Rules` | REG_MULTI_SZ | Rules that replace the user's own, one per line. |
| `OrgRules` | REG_MULTI_SZ | Rules added after the user's own, so they read as the more recent instruction. Users see them in settings but can't change them. |
| `InstructionFiles` | REG_MULTI_SZ | Workspace files the model follows, one per line, such as `AGENTS.md`. |
| `CompactAtTokens` | REG_DWORD | When the older part of a chat is summarized (30,000 or more). |
| `MaxRounds` | REG_DWORD | The most steps with tool calls for one message (1–100). |
| `StorageLimitGB` | REG_DWORD | The most disk space Undo's backups may use. |

A value of the wrong kind (a word where a number belongs, an unknown effort) isn't used, and Solder's
**⋯ → Copy diagnostics** names it, along with which settings are enforced.

## Group Policy

The templates are in [`policy/`](../policy) and attached to every release:

1. Copy `Solder.admx` to `C:\Windows\PolicyDefinitions` (or your domain's Central Store,
   `\\<domain>\SYSVOL\<domain>\Policies\PolicyDefinitions`), and `en-US\Solder.adml` to its `en-US` folder.
2. In the Group Policy editor, the settings are under **Administrative Templates → Solder**, for both
   Computer and User Configuration.

## Intune

Either of these:

- **Import the ADMX** (Devices → Configuration → Import ADMX), then create a profile from its templates in the
  Settings catalog.
- **Set the registry values directly** with a script or remediation, under `HKLM\SOFTWARE\Policies\Gremnar\Solder`.

## Checking it

On a user's PC, open Solder's settings: enforced fields are locked and marked. **⋯ → Copy diagnostics** lists
the enforced settings by name (never their values). To see the raw values:
`reg query HKLM\SOFTWARE\Policies\Gremnar\Solder`.
