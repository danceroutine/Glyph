enum ControlState {
  TEXT,
  ESCAPE,
  INTERMEDIATE,
  CSI,
  STRING,
  STRING_ESCAPE,
}

/** Strips controls incrementally without retaining unbounded escape payloads. */
export class TerminalControlFilter {
  private state = ControlState.TEXT;
  private osc = false;

  push(chunk: string): string {
    let text = '';
    for (const character of chunk) {
      if (character === '\x18' || character === '\x1a') {
        this.state = ControlState.TEXT;
        continue;
      }
      if (this.state === ControlState.STRING || this.state === ControlState.STRING_ESCAPE) {
        if (
          character === '\x9c' ||
          (this.osc && character === '\x07') ||
          (this.state === ControlState.STRING_ESCAPE && character === '\\')
        )
          this.state = ControlState.TEXT;
        else this.state = character === '\x1b' ? ControlState.STRING_ESCAPE : ControlState.STRING;
        continue;
      }
      if (character === '\x1b') {
        this.state = ControlState.ESCAPE;
        continue;
      }
      switch (this.state) {
        case ControlState.ESCAPE:
          if (character === '[') this.state = ControlState.CSI;
          else if (']PX^_'.includes(character)) {
            this.osc = character === ']';
            this.state = ControlState.STRING;
          } else this.state = character >= ' ' && character <= '/' ? ControlState.INTERMEDIATE : ControlState.TEXT;
          break;
        case ControlState.INTERMEDIATE:
          if (character >= '0' && character <= '~') this.state = ControlState.TEXT;
          break;
        case ControlState.CSI:
          if (character >= '@' && character <= '~') this.state = ControlState.TEXT;
          break;
        case ControlState.TEXT:
          if (character === '\x9b') this.state = ControlState.CSI;
          else if ('\x90\x98\x9d\x9e\x9f'.includes(character)) {
            this.osc = character === '\x9d';
            this.state = ControlState.STRING;
          } else if (character !== '\x9c') text += character;
          break;
      }
    }
    return text;
  }
}
