/**
 * 纪律状态。数值即状态机内部编码，勿改动顺序。
 */
export var DisciplineState;
(function (DisciplineState) {
    /** 无处分 */
    DisciplineState[DisciplineState["None"] = 0] = "None";
    /** 审查中 */
    DisciplineState[DisciplineState["Review"] = 1] = "Review";
    /** 处分中 */
    DisciplineState[DisciplineState["Punishment"] = 2] = "Punishment";
    /** 已解决 */
    DisciplineState[DisciplineState["Resolved"] = 3] = "Resolved";
})(DisciplineState || (DisciplineState = {}));
