# Permission model

Accounts have an owner (created by the installer, cannot be edited) and members. Members get capabilities, not roles. Presets are only shortcuts:

| Preset | Instance capabilities | Panel capabilities |
|---|---|---|
| Viewer | view | none |
| Operator | view, console, power | none |
| Manager | + files, mods, backups, settings | create instances |
| Administrator | + remove | manage users, create instances, update |

## Capabilities per instance
`view`, `console` (console and players), `power` (start, stop, restart), `files`, `mods`, `backups`, `settings`, `remove`.

A default set applies to every instance, and each instance can override it.

## Panel capabilities
`users`, `create`, `update`.

## Rules
- The controller enforces them, and each worker enforces them again from the `x-meow-caps` header.
- Changing Java or JVM arguments needs `files`, because it allows running arbitrary code as the panel user.
- Scheduling a task needs `settings` plus the capability of its action (`backups`, `power` or `console`).
- Only the owner may change accounts that can manage users.
