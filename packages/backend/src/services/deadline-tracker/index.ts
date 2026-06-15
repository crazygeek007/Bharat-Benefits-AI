export {
  DeadlineTracker,
  HIGH_PRIORITY_TRIGGER_WINDOW_MS,
  daysUntilDeadline,
  hoursUntilDeadline,
  shouldSendNotification,
  shouldSendDeadlineNotification,
  canSaveScheme,
  getDeadlinesWithinWindow,
} from './deadline-tracker';
export type {
  DeadlineCheckResult,
  DeadlineTrackerOptions,
  DeadlineTrigger,
  RecordNotificationArgs,
  SavedSchemeWithScheme,
} from './deadline-tracker';
