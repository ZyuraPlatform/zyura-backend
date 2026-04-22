
import { debugLog } from "./debugLog";

type TGoal = {
    selectedSubjects: {
        subjectName: string;
        systemNames: string[];
    }[];
};

export const buildGoalContentFilter = (
    goal: TGoal | null,
    existingFilters: Record<string, any> = {}
) => {
    // #region agent log
    debugLog({runId:'pre-fix',hypothesisId:'H1',location:'findContentQueryBuilder.ts:buildGoalContentFilter',message:'buildGoalContentFilter called',data:{hasGoal:Boolean(goal),selectedSubjectsLen:(goal as any)?.selectedSubjects?.length||0,hasExistingAnd:Array.isArray((existingFilters as any)?.$and),existingKeys:Object.keys(existingFilters||{})}});
    // #endregion
    // If no goal or no subjects → return existing filters unchanged
    if (!goal || !goal.selectedSubjects?.length) {
        // #region agent log
        debugLog({runId:'pre-fix',hypothesisId:'H1',location:'findContentQueryBuilder.ts:return_no_goal',message:'buildGoalContentFilter returning existingFilters (no goal subjects)',data:{}});
        // #endregion
        return existingFilters;
    }

    const goalOrConditions = goal.selectedSubjects.map((item) => {
        const condition: any = {
            subject: item.subjectName,
        };

        if (item.systemNames?.length) {
            condition.system = { $in: item.systemNames };
        }

        return condition;
    });

    return {
        ...existingFilters,
        $and: [
            ...(existingFilters.$and || []),
            { $or: goalOrConditions },
        ],
    };
};
