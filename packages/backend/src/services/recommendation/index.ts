export {
  RecommendationEngine,
  recommendationEngine,
  calculateMatchScore,
  applyStateAwarePrioritization,
  assignPriorityGroup,
  buildRecommendation,
  generateExplanation,
  isUrgentDeadline,
  MATCH_SCORE_WEIGHTS,
  URGENT_DEADLINE_DAYS,
  RECENT_UPDATE_DAYS,
} from './recommendation-engine';
export type { RecommendationEnginePrisma } from './recommendation-engine';
