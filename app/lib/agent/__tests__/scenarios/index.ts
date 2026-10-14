import type { Scenario } from "../harness";
import * as budget from "./budget";
import * as degradation from "./degradation";
import * as grounding from "./grounding";
import * as planning from "./planning";
import * as authority from "./authority";
import * as shade from "./shade";

/** Every scenario the C1 harness replays, in reading order. */
export const scenarios: Scenario[] = [
  planning.happyPathShadowedAfternoon,
  planning.fallbackPlotWhenModelForgets,
  planning.modelPlotsItselfNoDuplicate,
  planning.locateUserThenPlan,
  planning.setTimePrecedesShadowCheck,
  planning.routePlanningPlotsEndpoints,
  grounding.toolErrorStaysHonest,
  grounding.emptySearchInventsNothing,
  grounding.noResearchNoPins,
  grounding.unknownLocationAsksInstead,
  grounding.fallbackPinsCapAtEight,
  grounding.duplicateHitsBecomeOnePin,
  grounding.viaStopsBecomePins,
  grounding.partialPlotIsCompletedAfterAnswer,
  grounding.cappedPlaceNamedGetsPinned,
  grounding.sharedModelAnswerIsReconciled,
  grounding.followUpTurnKnowsEarlierPins,
  grounding.partialNamesAreNotPlaces,
  grounding.evictionSparesNamedPins,
  grounding.onePlaceOnePin,
  grounding.modelsBarePinsGetNamesAndTheCap,
  budget.stepBudgetExhaustedStillPlots,
  budget.candidatesOverflowCapAtEightPins,
  budget.sharedModelSkipsWriteCall,
  budget.batchedShadowCheckPinsEverySpot,
  budget.askedRouteIsCalculated,
  budget.repeatedCallIsNotRerun,
  budget.emptySearchIsReformulated,
  budget.vagueSitQueryFindsPins,
  budget.searchingClosesAfterFour,
  degradation.blockedPromptDegrades,
  degradation.emptyResearchFallsThroughToWrite,
  degradation.emptyWriteSaysSo,
  degradation.writeCallThatToolCallsStaysAnAnswer,
  authority.untrustedProviderContentCannotMutate,
  authority.untrustedToolErrorCannotMutate,
  shade.shadeWindowToday,
  shade.shadeAnotherDate,
  shade.sunModeSearch,
  shade.shadeNearMapCentre,
  shade.shadeLikeThisOne,
  shade.shadeCrossesSunset,
  shade.rightNowUsesCheckShadow,
  shade.outsideCoverageSaysSo,
  shade.pureLookupNoShadeSearch,
  shade.offTopicNoTools,
  shade.findThenRouteThere,
];
