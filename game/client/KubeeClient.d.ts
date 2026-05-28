type LoadingData = {
  /** Loading progress 0-100 */
  progress?: number;
  /** Loading hint message, e.g. "Loading map..." */
  message?: string;
  [key: string]: any;
};

type MatchStartData = {
  /** Game mode, e.g. 'pvp' | 'pve' | 'tutorial' */
  mode?: string;
  playerCount?: number;
  [key: string]: any;
};

type MatchEndData = {
  result?: 'win' | 'lose' | 'draw';
  score?: number;
  /** Match duration in seconds */
  duration?: number;
  [key: string]: any;
};

type PlayerSpawnData = {
  playerId?: string;
  [key: string]: any;
};

type PlayerDeathData = {
  playerId?: string;
  killedBy?: string;
  /** Cause of death, e.g. 'enemy' | 'fall' | 'timeout' */
  cause?: string;
  [key: string]: any;
};

type GameClient = {
  /**
   * Game resources are loading. The platform will show a loading screen.
   * Call when resource loading begins; can be called multiple times to update progress.
   *
   * @example
   * KubeeClient.game.loading({ progress: 0, message: 'Loading resources...' });
   * // ... during loading ...
   * KubeeClient.game.loading({ progress: 50, message: 'Loading map...' });
   */
  loading(data?: LoadingData): void;

  /**
   * Game resources finished loading. The platform will hide the loading screen.
   * Call when all resources are loaded and the game is ready for interaction (call only once).
   *
   * @example
   * KubeeClient.game.loaded();
   */
  loaded(): void;

  /**
   * Match started. Call when the player officially enters gameplay.
   *
   * @example
   * KubeeClient.game.matchStart({ mode: 'pve' });
   */
  matchStart(data?: MatchStartData): void;

  /**
   * Match ended. Call when a game round ends, with result information.
   *
   * @example
   * KubeeClient.game.matchEnd({ result: 'win', score: 1500, duration: 120 });
   */
  matchEnd(data?: MatchEndData): void;

  /**
   * Player spawned or respawned. Call when a player character is created or revived.
   *
   * @example
   * KubeeClient.game.playerSpawn({ playerId: 'player1' });
   */
  playerSpawn(data?: PlayerSpawnData): void;

  /**
   * Player died. Call when a player character dies.
   *
   * @example
   * KubeeClient.game.playerDeath({ playerId: 'player1', cause: 'enemy' });
   */
  playerDeath(data?: PlayerDeathData): void;

  /**
   * Send a custom event (use when standard events above are insufficient).
   *
   * @example
   * KubeeClient.game.emit('level_up', { level: 5 });
   */
  emit(name: string, data?: Record<string, any>): void;

  /** Listen for events (inter-module communication within the game) */
  on(type: string, handler: (data: any) => void): void;

  /** Remove event listener */
  off(type: string, handler: (data: any) => void): void;
};

type UserInfo = {
  /** User nickname */
  nickname: string;
};

type CloudDataPayload = unknown;

type KubeeClientType = {
  game: GameClient;
  getUserInfo: () => Promise<UserInfo | null>;
  /**
   * Save game data to the specified cloud slot.
   * If the game needs save/load capability, it must use this API for persistence.
   * Never use localStorage for game saves.
   */
  saveCloudData: (slotid: string, payload: CloudDataPayload) => Promise<void>;
  /**
   * Load game data from the specified cloud slot.
   * If the game needs save/load capability, it must use this API for persistence.
   * Never use localStorage for game saves.
   */
  getCloudData: (slotid: string) => Promise<CloudDataPayload | null>;
};

/** @deprecated Use KubeeClientType instead */
type KubeeClient = KubeeClientType;

declare global {
  var KubeeClient: KubeeClientType;
  /** @deprecated Use KubeeClient instead */
  var KubeeClient: KubeeClientType;
}

export {};
