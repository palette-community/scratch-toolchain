/**
 * Public API for the extension-git package.
 *
 * This is the "extension" half of the git-palette split: it owns everything
 * about Scratch *extensions* (custom + built-in), so the vanilla half
 * (`scratch-git`) can stay focused on the core workflow and simply depend on
 * this package for extension parsing/registration.
 *
 * @module extension-git
 */
export {
  resolveExtensions,
  registerCachedExtensions,
} from './extresolve.js';
export { registerTurbowarpBuiltins } from './builtins.js';
