export interface ModelSource {
  readonly name: string;
  readonly order?: number;
  run(): Promise<void>;
}
