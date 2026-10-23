enum ControlState {
  TEXT = 0,
  ESCAPE = 1,
  INTERMEDIATE = 2,
  CSI = 3,
  STRING = 4,
  STRING_ESCAPE = 5,
}

/** Strips controls incrementally without retaining unbounded escape payloads. */
export class TerminalControlFilter {
  private state = ControlState.TEXT;
  private osc = false;

  push(chunk: string): string {
    let text = '';
    for (const character of chunk) {
      if (character === '\u0018' || character === '\u001A') {
        this.state = ControlState.TEXT;
        continue;
      }
      if (this.state === ControlState.STRING || this.state === ControlState.STRING_ESCAPE) {
        if (
          character === '\u009C' ||
          (this.osc && character === '\u0007') ||
          (this.state === ControlState.STRING_ESCAPE && character === '\\')
        )
          this.state = ControlState.TEXT;
        else this.state = character === '\u001B' ? ControlState.STRING_ESCAPE : ControlState.STRING;
        continue;
      }
      if (character === '\u001B') {
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
          if (character === '\u009B') this.state = ControlState.CSI;
          else if ('\u0090\u0098\u009D\u009E\u009F'.includes(character)) {
            this.osc = character === '\u009D';
            this.state = ControlState.STRING;
          } else if (character !== '\u009C') text += character;
          break;
      }
    }
    return text;
  }
}
