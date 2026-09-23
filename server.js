// OpenCode V2 entry point for directory plugins (`"plugins": ["file:///path/to/repo"]`):
// the V2 host resolves `<dir>/server` (then `<dir>/index`), not package.json `main`.
export { ClaudeCodePlugin, default } from "./opencode-claude.js";
