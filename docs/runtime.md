# Runtime and shared modules

The modules in `modules/` (Modrinth, backups, scheduler, safety checks, login limiter) are identical in every product. They never know whether a server is a host process or a container. Everything that depends on how a server runs sits behind the **runtime**, a `runtime/` folder in each product.

| Product | Runtime |
|---|---|
| LITE | host process: spawn, Java lookup and install, launch options, port check, process metrics |
| PROFESSIONAL | Docker: containers, images, cgroup limits, container metrics |

## Contract

`modules/runtime-contract.js` lists the methods a runtime provides for one instance:
`isRunning`, `isReady`, `start`, `stop`, `restart`, `kill`, `stopAndWait`, `command`. A product calls `assertRuntime(runtime)` at startup.

## Rules

- A shared module talks to the runtime and to files in the instance folder, nothing else.
- Instance folders are plain host folders in both products (PROFESSIONAL uses a bind mount), so files, mods and backups work the same way.
- Product-specific things (Java in LITE, images and limits in PROFESSIONAL) stay in the product's `runtime/` folder.
- Change modules only here, then run `node scripts/sync.js --assets <repo>`.
