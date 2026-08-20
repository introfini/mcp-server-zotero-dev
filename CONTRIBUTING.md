# Contributing

Thanks for considering a contribution. This document covers what you need to know before opening a pull request: how to run the project, what to check before you push, and the few conventions that are specific enough to this codebase that you would not guess them.

Start with [ARCHITECTURE.md](ARCHITECTURE.md) if you are touching the RDP layer. It explains the actor hierarchy and the pitfalls that are not obvious from the code.

## Prerequisites

- **Node.js 20+**
- **Zotero 7 or later**, running, with the **MCP Bridge for Zotero** plugin installed. Most of this project cannot be exercised without it: the server talks to a live Zotero over the Firefox Remote Debugging Protocol on port 6100.

Verify the bridge answers before you start debugging anything else. The `zotero_ping` tool is the usual check.

## Setup

```bash
git clone https://github.com/introfini/mcp-server-zotero-dev.git
cd mcp-server-zotero-dev
npm install
npm run build
```

This is an npm workspaces monorepo. Use the package names, not the folder names, when targeting a single package:

```bash
npm run build -w @introfini/mcp-server-zotero-dev
npm run build -w zotero-plugin-mcp-rdp
npm run dev   -w @introfini/mcp-server-zotero-dev   # tsc --watch
```

## Before you open a pull request

**There is no CI.** Nothing runs on push, so these are on you:

```bash
npm run build
npm run typecheck
npm run lint
npm test
```

Please say in the PR description which of these you ran and against which Zotero version. "Verified against Zotero X.Y.Z" is worth more than a green checkmark that does not exist here.

## Tests

Tests live in `packages/mcp-server/tests/`, flat, one file per tool group.

```
packages/mcp-server/tests/
└── db-tools.test.mts       # zotero_db_query / zotero_db_schema, against a live Zotero
```

Four things generalise to any new test file:

**Use `.mts`, not `.ts`.** `packages/mcp-server/package.json` has no `"type": "module"` and the build emits CommonJS, so vitest transforms a `.test.ts` as CJS and any top-level `await` fails to compile. The `.mts` extension forces ESM for that file.

**Prefer integration tests where the bug lives in the runtime.** Several defects in this codebase only exist against a real Zotero, and a mocked RDP layer passes happily on broken code. The clearest example is [#20](https://github.com/introfini/mcp-server-zotero-dev/issues/20): Zotero wraps DB rows in a `Proxy` with no `ownKeys` trap, and nested values degrade during RDP grip resolution. Neither is reproducible against a mock. When you mock, say in a comment why the mock is sufficient.

**Skip, do not fail, when Zotero is absent.** Guard the suite with `describe.skipIf` so `npm test` stays green on a machine without Zotero. Probe the `Zotero` global itself, with `evaluateJSAsync("typeof Zotero")`, rather than checking that port 6100 accepts a TCP connection: a Zotero running with no window open keeps the port listening while every tool fails with `Zotero is not defined`.

**Tests are currently neither typechecked nor linted.** `tsconfig.json` has `include: ["src/**/*"]` and lint runs `eslint src --ext .ts`. Keeping tests out of the published `dist/` is deliberate; wiring them into a separate `tsconfig.test.json` is open work. Until then, type errors in a test file will not be caught by `npm run typecheck`.

## Code conventions

**Never return a raw nested object from `evaluateJS`.** This is the one rule most likely to bite you. `JSON.stringify` the payload inside the evaluated code and `JSON.parse` it host-side:

```js
const code = `
  (async () => {
    try {
      const result = { rows, columns };
      return JSON.stringify(result);   // <- not: return result;
    } catch (error) {
      return JSON.stringify({ error: error.message });
    }
  })()
`;
```

RDP object previews are one level deep. A nested array or object comes back as a bare grip that `gripToValue` cannot resolve, and it falls through to a placeholder string such as `"[Array]"`. Sometimes that throws loudly; sometimes it formats into output that looks fine and is wrong. Strings marshal reliably as `longString` grips, which is why every tool file follows this pattern.

Also check `response.exception` before using `response.result`. An evaluation that threw still returns a result, and using it silently produces `[object Object]` in your output.

**TypeScript.** Strict mode, `async`/`await` throughout, explicit interfaces for RDP messages and responses. Note that a cast on the value returned by `gripToValueAsync` is an unverified assertion about what the RDP actually resolved, so the compiler cannot protect you from the problem above.

**Tool responses** should be actionable, including context and a hint at the next step:

```ts
return {
  content: [
    { type: "text", text: "Found 3 toolbar buttons..." },
    { type: "text", text: "Next: Use zotero_get_styles to inspect their CSS" },
  ],
};
```

**Errors** should say what to check, not just what failed:

```ts
throw new Error(
  "Cannot connect to Zotero RDP. Ensure:\n" +
    "1. Zotero is running\n" +
    "2. MCP Bridge for Zotero plugin is installed\n" +
    "3. Port 6100 is not blocked"
);
```

## Working on the bridge plugin

`packages/zotero-plugin-mcp-rdp/src/bootstrap.js` runs in Zotero's bootstrap context, which is not a normal JavaScript environment:

- `console` does not exist. Use `dump("message\n")` or `Zotero.debug(msg)`.
- `ChromeUtils.import` was removed in Firefox ESR 128+. Use `ChromeUtils.importESModule` for `.sys.mjs` modules.
- `Zotero.Prefs.get(name)` resolves `name` under the `extensions.zotero.` branch. For a literal pref name such as `extensions.mcp-rdp.port` you must pass `true` as the second argument, or the value is silently ignored and the default wins.

**Review the built XPI, not the source.** The build does not ship every file in `src/`, and a fix that exists only in an ignored file will look correct in review and do nothing in practice:

```bash
unzip -p build/zotero-mcp-bridge-X.Y.Z.xpi bootstrap.js | grep yourChange
```

A first-time sideload into `<profile>/extensions/` installs the plugin **disabled**, which is standard Firefox behaviour. Enable it in the Plugins Manager, otherwise none of its code runs and the RDP port never opens.

## Reporting bugs

Include the versions. A table like this makes a report actionable immediately:

| | |
|---|---|
| `@introfini/mcp-server-zotero-dev` | 1.1.3 |
| Zotero | 9.0.6 |
| MCP Bridge for Zotero plugin | 1.0.5 |
| OS / Node | macOS 15 / Node 22 |

Then the smallest call that reproduces it, what you expected, and what you got. If you have traced the cause, quote the line and link it at a commit rather than at `main`, so the link keeps pointing at the code you meant.

## Releases

Publishing to npm, the MCP Registry and the GitHub release feed is handled by the maintainer. You do not need to bump versions or touch `update.json` in a pull request.
