/** Browser-safe Scene Canvas adoption state. It is an explicit preview, never a Git claim. */
export interface SceneAdoptionViewV1 {
  readonly version: 1;
  readonly eventId: string;
  readonly revisionId: string;
  readonly proseHash: string;
  readonly released: boolean;
  /** Fixed disclosure shown before an explicit authoring adoption command. */
  readonly disclosure: 'accepted generated prose will enter the authoring manifest';
}
