/**
 * Terminal colour, with chalk treated as optional.
 *
 * chalk is declared in `optionalDependencies` so the CLI supports a minimal
 * install profile:
 *
 *     npm i -g @promptowl/contextnest-cli --omit=optional
 *
 * That install has no runtime dependencies at all. When chalk is absent we fall
 * back to a formatter that returns the string unchanged, so every existing
 * `chalk.red(...)` / `chalk.cyan.bold(...)` call site keeps working — it just
 * emits no ANSI codes. See DEPENDENCIES.md.
 */

import type { ChalkInstance } from "chalk";

/**
 * A chalk-shaped no-op: any property is another formatter, and calling one
 * returns its argument as a plain string.
 */
function plainChalk(): ChalkInstance {
  const format = (value: unknown) => String(value ?? "");
  const proxy: unknown = new Proxy(format, {
    get: (_target, prop) => {
      // Must never look thenable, or an accidental `await` on a style would hang.
      if (prop === "then") return undefined;
      if (prop === "level") return 0;
      return proxy;
    },
    apply: (_target, _self, args: unknown[]) => String(args[0] ?? ""),
  });
  return proxy as ChalkInstance;
}

const chalk: ChalkInstance = await import("chalk")
  .then((mod) => mod.default)
  .catch(() => plainChalk());

export default chalk;
