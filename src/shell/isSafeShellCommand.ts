const SAFE_PROGRAMS = new Set([
  'basename',
  'cat',
  'cut',
  'dirname',
  'du',
  'file',
  'find',
  'grep',
  'head',
  'ls',
  'pwd',
  'rg',
  'sed',
  'sort',
  'stat',
  'tail',
  'tr',
  'tree',
  'uniq',
  'wc',
]);

const DANGEROUS_ARGUMENTS = new Set([
  '--exec',
  '--ext-diff',
  '--output',
  '--pre',
  '--write',
  '-delete',
  '-exec',
  '-execdir',
  '-f',
  '-i',
  '-o',
  '-ok',
  '-okdir',
]);

/**
 * Recognizes deliberately small, non-compound inspection commands. This is an
 * approval convenience rather than the security boundary; recognized commands
 * still execute inside the read-only OS sandbox.
 */
export function isSafeShellCommand(command: string): boolean {
  const arguments_ = tokenizeSimpleCommand(command);
  if (!arguments_ || arguments_.length === 0) return false;
  const program = basename(arguments_[0]!);
  if (arguments_[0] !== program) return false;
  if (arguments_.slice(1).some(argument => isDangerousArgument(argument) || isSensitiveArgument(argument))) {
    return false;
  }
  return SAFE_PROGRAMS.has(program);
}

function tokenizeSimpleCommand(command: string): string[] | undefined {
  const tokens: string[] = [];
  let token = '';
  let quote: "'" | '"' | undefined;
  let escaping = false;
  for (const character of command.trim()) {
    if (escaping) {
      token += character;
      escaping = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else if (quote === '"' && (character === '$' || character === '`')) return undefined;
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '\n' || character === '\r') return undefined;
    if (/\s/u.test(character)) {
      if (token) {
        tokens.push(token);
        token = '';
      }
      continue;
    }
    if (';&|<>`$(){}\n\r'.includes(character)) return undefined;
    token += character;
  }
  if (escaping || quote) return undefined;
  if (token) tokens.push(token);
  return tokens;
}

function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
}

function isDangerousArgument(argument: string): boolean {
  if (DANGEROUS_ARGUMENTS.has(argument)) return true;
  if (/^-(?:i|o).+/u.test(argument)) return true;
  return [...DANGEROUS_ARGUMENTS].some(value => value.startsWith('--') && argument.startsWith(`${value}=`));
}

function isSensitiveArgument(argument: string): boolean {
  if (argument === '/' || argument === '/dev' || argument.startsWith('/dev/')) return true;
  const name = basename(argument.replace(/\/+$/u, ''));
  if (name === '.env.example') return false;
  if (matchesSensitiveName(name)) return true;
  return /\.(?:key|pem|p12|pfx)$/u.test(name);
}

function matchesSensitiveName(name: string): boolean {
  return name.startsWith('.env') || ['.netrc', '.npmrc', '.pypirc', '.git-credentials'].includes(name);
}
