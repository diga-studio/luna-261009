import type {
  ColumnRef,
  Condition,
  DiagnosticReport,
  Operand,
  QueryBlock,
  SelectStatement,
  TableSchema,
} from "./types.js";

/** 基础列引用：某个读取实例上的基础列 */
interface BaseRef {
  inst: number;
  column: string;
}

interface ScopeCol {
  name: string;
  ref: BaseRef | null;
}

/** 一个可见作用域：限定名集合 + 暴露列 */
interface Scope {
  qualifiers: string[];
  columns: ScopeCol[];
}

type ConstraintKind = "eq" | "range";
/** 一个分支：基础列 -> 约束种类（同列 eq 优先于 range） */
type Branch = Map<string, ConstraintKind>;

interface Instance {
  table: string;
  schema: TableSchema | null;
  path: string[];
  layers: Branch[][];
}

interface CteEntry {
  query: SelectStatement;
  env: Map<string, CteEntry>;
}

interface ResolvedSource {
  scope: Scope;
}

export function analyze(statements: SelectStatement[], schemas: TableSchema[]): DiagnosticReport {
  const ctx = new Analyzer(schemas);
  for (const stmt of statements) {
    ctx.resolveSelect(stmt, new Map(), [], []);
  }
  return { instances: ctx.instances.map((inst) => ctx.report(inst)) };
}

class Analyzer {
  instances: Instance[] = [];
  private schemaByName = new Map<string, TableSchema>();

  constructor(schemas: TableSchema[]) {
    for (const s of schemas) this.schemaByName.set(s.name, s);
  }

  /** 解析一条 SELECT（含其 CTE），返回该查询暴露的作用域 */
  resolveSelect(
    stmt: SelectStatement,
    outerEnv: Map<string, CteEntry>,
    outerScopes: Scope[],
    pathPrefix: string[],
  ): Scope {
    const env = new Map(outerEnv);
    for (const cte of stmt.ctes) {
      env.set(cte.name, { query: cte.query, env: new Map(env) });
    }
    return this.resolveBlock(stmt.body, env, outerScopes, pathPrefix);
  }

  private resolveBlock(
    block: QueryBlock,
    env: Map<string, CteEntry>,
    outerScopes: Scope[],
    pathPrefix: string[],
  ): Scope {
    const src = block.source;
    let sourceScope: Scope;
    let qualifiers: string[] = [];
    if (src.kind === "table") {
      const cte = env.get(src.name);
      if (cte) {
        // CTE 引用：透明视图，每次引用独立诊断
        const label = src.alias ? `${src.name} AS ${src.alias}` : src.name;
        sourceScope = this.resolveSelect(cte.query, cte.env, [], [...pathPrefix, label]);
      } else {
        // 基础表：新建读取实例
        const schema = this.schemaByName.get(src.name) ?? null;
        const instId = this.instances.length;
        const label = src.alias ? `${src.name} AS ${src.alias}` : src.name;
        this.instances.push({
          table: src.name,
          schema,
          path: [...pathPrefix, label],
          layers: [],
        });
        sourceScope = {
          qualifiers: [],
          columns: (schema?.columns ?? []).map((c) => ({
            name: c,
            ref: { inst: instId, column: c },
          })),
        };
      }
      qualifiers = [src.alias ?? src.name];
    } else {
      // FROM 子查询：透明视图，不可见外层列（无 LATERAL）
      const label = src.alias ? `(subquery) AS ${src.alias}` : "(subquery)";
      sourceScope = this.resolveSelect(src.query, env, [], [...pathPrefix, label]);
      qualifiers = src.alias ? [src.alias] : [];
    }
    // 当前块作用域：源暴露列 + 可见限定名（有别名时原名不可见）
    const current: Scope = { qualifiers, columns: sourceScope.columns };
    this.attachWhere(block, current, outerScopes, env);
    // 本块投影决定对外暴露的列
    return this.applyProjection(block, current);
  }

  /** 应用投影：直接列、重命名、星号 */
  private applyProjection(block: QueryBlock, inner: Scope): Scope {
    const out: ScopeCol[] = [];
    for (const item of block.projection) {
      if (item.kind === "star") {
        out.push(...inner.columns);
      } else if (item.kind === "column") {
        const ref = this.findInScope(item.column, inner);
        out.push({ name: item.alias ?? item.column.name, ref: ref ?? null });
      }
      // literal：不暴露列
    }
    return { qualifiers: [], columns: out };
  }

  private findInScope(col: ColumnRef, scope: Scope): BaseRef | null | undefined {
    if (col.qualifier !== null && !scope.qualifiers.includes(col.qualifier)) return undefined;
    let found: BaseRef | null | undefined = undefined;
    for (const c of scope.columns) {
      if (c.name === col.name) found = c.ref;
    }
    return found;
  }

  /** 列绑定：最近可见作用域优先；返回 local 引用 / outer / unbound */
  private bindColumn(
    col: ColumnRef,
    current: Scope,
    outerScopes: Scope[],
  ): { type: "local"; ref: BaseRef | null } | { type: "outer" } | { type: "unbound" } {
    const local = this.findInScope(col, current);
    if (local !== undefined) return { type: "local", ref: local };
    for (let i = outerScopes.length - 1; i >= 0; i--) {
      const r = this.findInScope(col, outerScopes[i]);
      if (r !== undefined) return { type: "outer" };
    }
    return { type: "unbound" };
  }

  /** 处理 WHERE：提取约束层并诊断 EXISTS 子查询 */
  private attachWhere(
    block: QueryBlock,
    current: Scope,
    outerScopes: Scope[],
    env: Map<string, CteEntry>,
  ): void {
    if (!block.where) return;
    const branches = this.toBranches(block.where, current, outerScopes, env);
    // 当前块可达的全部实例（单数据源链条）
    const instIds = new Set<number>();
    for (const c of current.columns) {
      if (c.ref) instIds.add(c.ref.inst);
    }
    for (const inst of instIds) {
      const layer: Branch[] = branches.map((branch) => branch.get(inst) ?? new Map());
      this.instances[inst].layers.push(layer);
    }
  }

  /** 条件转 DNF 分支；每个分支为 实例id -> (列 -> 约束种类) */
  private toBranches(
    cond: Condition,
    current: Scope,
    outerScopes: Scope[],
    env: Map<string, CteEntry>,
  ): Map<number, Branch>[] {
    switch (cond.kind) {
      case "and": {
        let acc: Map<number, Branch>[] = [new Map()];
        for (const item of cond.items) {
          const sub = this.toBranches(item, current, outerScopes, env);
          const next: Map<number, Branch>[] = [];
          for (const a of acc) {
            for (const b of sub) {
              next.push(this.mergeBranchMaps(a, b));
            }
          }
          acc = next;
        }
        return acc;
      }
      case "or": {
        const out: Map<number, Branch>[] = [];
        for (const item of cond.items) out.push(...this.toBranches(item, current, outerScopes, env));
        return out;
      }
      case "comparison":
      case "between":
      case "in":
      case "isNull": {
        const m = new Map<number, Branch>();
        const c = this.atomConstraint(cond, current, outerScopes);
        if (c) {
          const b = new Map();
          b.set(c.column, c.kind);
          m.set(c.inst, b);
        }
        return [m];
      }
      case "unsupported":
        return [new Map()];
      case "exists": {
        // 内部读取实例独立诊断；可绑定外层列；不为父查询提供约束
        this.resolveSelect(cond.query, env, [...outerScopes, current], []);
        return [new Map()];
      }
    }
  }

  private mergeBranchMaps(a: Map<number, Branch>, b: Map<number, Branch>): Map<number, Branch> {
    const out = new Map<number, Branch>();
    for (const [inst, branch] of a) out.set(inst, new Map(branch));
    for (const [inst, branch] of b) {
      let target = out.get(inst);
      if (!target) out.set(inst, (target = new Map()));
      for (const [col, kind] of branch) {
        if (target.get(col) !== "eq") target.set(col, kind);
      }
    }
    return out;
  }

  private operandSide(
    op: Operand,
    current: Scope,
    outerScopes: Scope[],
  ): { type: "local"; ref: BaseRef | null } | { type: "value" } | { type: "none" } {
    if (op.kind === "literal") return { type: "value" };
    const b = this.bindColumn(op.column, current, outerScopes);
    if (b.type === "outer") return { type: "value" };
    if (b.type === "unbound") return { type: "none" };
    return { type: "local", ref: b.ref };
  }

  private atomConstraint(
    cond: Extract<Condition, { kind: "comparison" | "between" | "in" | "isNull" }>,
    current: Scope,
    outerScopes: Scope[],
  ): { inst: number; column: string; kind: ConstraintKind } | null {
    const of = (ref: BaseRef, kind: ConstraintKind) => ({ inst: ref.inst, column: ref.column, kind });
    if (cond.kind === "isNull") {
      const s = this.operandSide(cond.operand, current, outerScopes);
      if (s.type === "local" && s.ref) return of(s.ref, "eq");
      return null;
    }
    if (cond.kind === "in") {
      const s = this.operandSide(cond.operand, current, outerScopes);
      if (s.type !== "local" || !s.ref) return null;
      for (const v of cond.values) {
        // 列表项必须是字面量或已绑定的外层列
        if (this.operandSide(v, current, outerScopes).type !== "value") return null;
      }
      return of(s.ref, "eq");
    }
    if (cond.kind === "between") {
      const s = this.operandSide(cond.operand, current, outerScopes);
      if (s.type !== "local" || !s.ref) return null;
      for (const v of [cond.low, cond.high]) {
        if (this.operandSide(v, current, outerScopes).type !== "value") return null;
      }
      return of(s.ref, "range");
    }
    // comparison
    const l = this.operandSide(cond.left, current, outerScopes);
    const r = this.operandSide(cond.right, current, outerScopes);
    const rangeOps = new Set(["<", "<=", ">", ">="]);
    if (cond.op === "=") {
      if (l.type === "local" && l.ref && r.type === "value") return of(l.ref, "eq");
      if (r.type === "local" && r.ref && l.type === "value") return of(r.ref, "eq");
      return null;
    }
    if (rangeOps.has(cond.op)) {
      if (l.type === "local" && l.ref && r.type === "value") return of(l.ref, "range");
      if (r.type === "local" && r.ref && l.type === "value") return of(r.ref, "range");
      return null;
    }
    // <> / != 不提供可用约束
    return null;
  }

  report(inst: Instance): import("./types.js").ReadInstanceReport {
    const indexes = inst.schema?.indexes ?? [];
    // 各层分支做笛卡尔积合并
    let combined: Branch[] = [new Map()];
    for (const layer of inst.layers) {
      const next: Branch[] = [];
      for (const a of combined) {
        for (const b of layer) {
          const merged: Branch = new Map(a);
          for (const [k, v] of b) {
            if (merged.get(k) !== "eq") merged.set(k, v);
          }
          next.push(merged);
        }
      }
      combined = next;
    }
    const prefixOf = (indexCols: string[], branch: Branch): number => {
      let len = 0;
      for (const col of indexCols) {
        const c = branch.get(col);
        if (c === "eq") {
          len++;
          continue;
        }
        if (c === "range") len++;
        break;
      }
      return len;
    };
    const indexReports = indexes.map((cols) => ({
      columns: cols,
      guaranteedPrefix: Math.min(...combined.map((b) => prefixOf(cols, b))),
    }));
    const hasFullScanBranch = combined.some((b) =>
      indexes.every((cols) => prefixOf(cols, b) === 0),
    );
    return {
      table: inst.table,
      path: inst.path.join(" -> "),
      indexes: indexReports,
      hasFullScanBranch,
    };
  }
}
