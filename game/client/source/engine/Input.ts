export class Input {
  private readonly keys = new Map<string, boolean>()
  private readonly handleKeyDown = (event: KeyboardEvent) => {
    this.keys.set(event.key.toLowerCase(), true)
  }
  private readonly handleKeyUp = (event: KeyboardEvent) => {
    this.keys.set(event.key.toLowerCase(), false)
  }

  constructor() {
    window.addEventListener('keydown', this.handleKeyDown)
    window.addEventListener('keyup', this.handleKeyUp)
  }

  isKeyDown(key: string): boolean {
    return this.keys.get(key.toLowerCase()) ?? false
  }

  update(): void {
    // No per-frame state to clear yet.
  }

  destroy(): void {
    window.removeEventListener('keydown', this.handleKeyDown)
    window.removeEventListener('keyup', this.handleKeyUp)
    this.keys.clear()
  }
}
