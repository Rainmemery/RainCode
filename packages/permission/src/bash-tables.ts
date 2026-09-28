/**
 * bash 求值器命令词表（02-module-design §6.2 只读白名单 / 高危根命令 / wrapper 清单）。
 * 独立成文件便于审计与后续扩充；由 bash-evaluator.ts 消费。
 */

/** wrapper 命令：剥壳后对内层命令求值（02 §6.2「识别 wrapper 命令」）。 */
export const WRAPPER_ROOTS = new Set([
  "sudo",
  "doas",
  "env",
  "nohup",
  "time",
  "timeout",
  "nice",
  "command",
  "stdbuf",
  "setsid",
]);

/** wrapper 选项中带独立取值的（剥壳时一并丢弃）。 */
export const WRAPPER_VALUE_OPTS = new Set(["-u", "-g", "-p", "-C", "-r", "-t", "-T", "-i", "-D", "-n"]);

/** 高危根命令（02 §6.2 示例 + Windows 常见破坏性/任意执行入口；禁止被通配规则 allow）。 */
export const DANGEROUS_ROOTS = new Set([
  "rm",
  "rmdir",
  "del",
  "erase",
  "rd",
  "format",
  "mkfs",
  "mkfs.ext2",
  "mkfs.ext3",
  "mkfs.ext4",
  "mkfs.vfat",
  "dd",
  "diskpart",
  "diskutil",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "stop-computer",
  "restart-computer",
  "cipher",
  "attrib",
  "chmod",
  "chown",
  "takeown",
  "icacls",
  "cacls",
  "reg",
  "regedit",
  "bcdedit",
  "vssadmin",
  "wmic",
  "sh",
  "bash",
  "zsh",
  "csh",
  "fish",
  "dash",
  "ksh",
  "cmd",
  "powershell",
  "pwsh",
  "eval",
  "exec",
  "source",
  ".",
  "kill",
  "pkill",
  "killall",
  "taskkill",
  "stop-process",
]);

/** 只读命令白名单根（02 §6.2「git status/log/diff、ls、cat 等」的保守扩集）。 */
export const READONLY_ROOTS = new Set([
  "ls",
  "dir",
  "pwd",
  "cat",
  "type",
  "head",
  "tail",
  "wc",
  "stat",
  "file",
  "du",
  "df",
  "tree",
  "findstr",
  "rg",
  "grep",
  "which",
  "where",
  "whoami",
  "hostname",
  "id",
  "groups",
  "uname",
  "date",
  "echo",
  "printf",
  "printenv",
  "true",
  "false",
  "sleep",
]);

/** git 只读子命令（写类子命令不在表内）。 */
export const READONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "shortlog",
  "reflog",
  "describe",
  "rev-parse",
  "ls-files",
  "ls-remote",
  "cat-file",
  "count-objects",
  "grep",
  "cherry",
  "branch",
  "tag",
  "remote",
  "config",
  "stash",
  "worktree",
]);

/** 脚本执行器：仅在纯版本/帮助旗标下判只读（-e/--eval 等任意执行入口不判只读）。 */
export const VERSION_ONLY_ROOTS = new Set([
  "node",
  "npm",
  "pnpm",
  "yarn",
  "npx",
  "python",
  "python3",
  "pip",
  "pip3",
  "java",
  "go",
  "cargo",
  "rustc",
  "dotnet",
]);

export const VERSION_FLAG = /^(-v|-V|--version|-h|--help|\/\?)$/i;

export const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
