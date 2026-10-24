/** Desktop choices preserve the shell sandbox and scope remembered grants to one command and directory. */
export enum GlyphApprovalDecision {
  DENY = 'deny',
  ALLOW_ONCE = 'allow_once',
  ALWAYS_ALLOW = 'always_allow',
  ALLOW_SAFE = 'allow_safe',
  DENY_AND_ALLOW_SAFE = 'deny_and_allow_safe',
}
