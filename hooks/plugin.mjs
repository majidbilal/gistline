// The plugin form of the hook, for platforms that load a module rather than run a command.
//
// ONE RESPONSIBILITY: expose the same advice as `hooks/pre-tool.mjs` through a plugin interface.
//
// WHY A SECOND FILE RATHER THAN A SECOND MODE. OpenCode and Kilo Code do not spawn a process before a tool runs; they import
// a module and call an exported function. That is a genuinely different integration shape, not a different protocol on the
// same shape — there is no stdin to read and no stdout to write.
//
// The ADVICE is shared. Both files import `adviseFor` and `extractCommand` from the command hook, so the rule about which
// commands are worth mentioning lives in one place. Two copies of that judgement drifting apart is how one platform starts
// nagging about `git status` while another stays quiet.

import { adviseFor, extractCommand } from "./pre-tool.mjs";

/**
 * The plugin entry point.
 *
 * Both platforms use the same broad shape: a default export that receives a context and returns an object of event
 * handlers. The event is named `tool.execute.before` on both.
 *
 * Returning nothing means "no comment", which is the correct response for the overwhelming majority of commands. A handler
 * that always returns something trains the reader to ignore it.
 */
export default function gistlinePlugin() {
  return {
    /**
     * Called before a tool runs.
     *
     * The signature differs slightly between hosts — some pass `(input, output)`, some pass a single object — so both are
     * accepted rather than assuming one. A plugin that throws on an unexpected argument shape would interrupt real work,
     * and the cost of tolerating both is three lines.
     */
    "tool.execute.before": async (input, output) => {
      const payload = output ?? input ?? {};
      const command = extractCommand(payload) || extractCommand(input ?? {});
      const advice = adviseFor(command);
      if (!advice) return undefined;

      // Written onto the output object where one was provided, since that is how these hosts collect context, and also
      // returned — hosts differ in which they read, and doing both costs nothing.
      if (output && typeof output === "object") {
        output.gistline = advice;
        if (typeof output.metadata === "object" && output.metadata) output.metadata.gistline = advice;
      }

      return { additionalContext: advice, systemMessage: advice };
    },
  };
}

/** Named export as well, because some loaders look for one and ignore a default. */
export const plugin = gistlinePlugin;
