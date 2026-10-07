/** Analyzer: resolves scopes, collects per-branch column constraints, and
 *  computes guaranteed index prefixes for every base-table read instance. */

import {
  CompareOp,
  Expr,
  IndexReport,
  ReadInstanceReport,
  SelectStmt,
  TableDef,
} from './types';

type ConstraintKind = 'eq' | 'range';

/** One OR-branch: base column -> strongest constraint kind on it. */
type Branch = Map<string, ConstraintKind>;

interface ReadInstance {
  table: TableDef;
  alias: string | null;
  path: string;
  branches: Branch[];
}

interface ColumnTarget {
  instance: ReadInstance;
  column: string;
}

interface ViewColumn {
  name: string;
  target: ColumnTarget;
}

/** One visible table-like scope entry (a base table, CTE reference, or subquery). */
interface ScopeEntry {
  /** Name visible to qualified references; null for anonymous subqueries. */
  name: string | null;
  columns: ViewColumn[];
}

interface CteEntry {
  query: SelectStmt;
  env: Map<string, CteEntry>;
  outerScopes: ScopeEntry[];
}

interface Atom {
  instance: ReadInstance;
  column: string;
  kind: ConstraintKind;
}

/** DNF branch as a flat list of constrained atoms. */
type AtomBranch = Atom[];

interface ResolvedColumn {
  target: ColumnTarget;
  /** 0 = column of the current query block's own source, >0 = outer scope. */
  distance: number;
}

const SWAP_OP: Record<CompareOp, CompareOp> = {
  '=': '=',
  '<': '>',
  '>': '<',
  '<=': '>=',
  '>=': '<=',
  '<>': '<>',
  '!=': '!=',
};

function mergeKind(a: ConstraintKind | undefined, b: ConstraintKind): ConstraintKind {
  // Equality dominates: a column with both equality and range counts as equality.
  if (a === 'eq' || b === 'eq') return 'eq';
  return 'range';
}

class Analyzer {
  private readonly tables = new Map<string, TableDef>();
  private readonly instances: ReadInstance[] = [];

  constructor(tables: TableDef[]) {
    for (const table of tables) this.tables.set(table.name, table);
  }

  analyze(statements: SelectStmt[]): ReadInstanceReport[] {
    statements.forEach((stmt, index) => {
      this.analyzeQuery(stmt, [], new Map(), `stmt${index + 1}`);
    });
    return this.instances.map((instance) => this.toReport(instance));
  }

  /** Analyzes one query block; returns the scope entry it exposes. */
  private analyzeQuery(
    stmt: SelectStmt,
    outerScopes: ScopeEntry[],
    outerEnv: Map<string, CteEntry>,
    path: string,
  ): ScopeEntry {
    // CTEs are visible to later CTEs and the main query; each reference is
    // analyzed separately, so shared CTEs produce independent read instances.
    const env = new Map(outerEnv);
    for (const cte of stmt.ctes) {
      env.set(cte.name, { query: cte.query, env: new Map(env), outerScopes });
    }

    const source = this.resolveSource(stmt.from, outerScopes, env, path);
    const scopes = [source, ...outerScopes];

    if (stmt.where !== null) {
      const dnf = this.toDnf(stmt.where, scopes, env, path);
      this.applyBranches(dnf);
    }

    return { name: source.name, columns: this.buildProjection(stmt, scopes) };
  }

  private resolveSource(
    from: SelectStmt['from'],
    outerScopes: ScopeEntry[],
    env: Map<string, CteEntry>,
    path: string,
  ): ScopeEntry {
    if (from.kind === 'subquery') {
      const inner = this.analyzeQuery(from.query, outerScopes, env, `${path} > subquery`);
      return { name: from.alias, columns: inner.columns };
    }

    const cte = env.get(from.name);
    if (cte !== undefined) {
      const inner = this.analyzeQuery(
        cte.query,
        cte.outerScopes,
        cte.env,
        `${path} > cte ${from.name}`,
      );
      return { name: from.alias ?? from.name, columns: inner.columns };
    }

    const table = this.tables.get(from.name);
    if (table === undefined) throw new Error(`Unknown table: ${from.name}`);

    const instance: ReadInstance = {
      table,
      alias: from.alias,
      path,
      branches: [new Map()],
    };
    this.instances.push(instance);
    const columns = table.columns.map((column) => ({
      name: column,
      target: { instance, column },
    }));
    return { name: from.alias ?? from.name, columns };
  }

  private buildProjection(stmt: SelectStmt, scopes: ScopeEntry[]): ViewColumn[] {
    const output: ViewColumn[] = [];
    for (const item of stmt.projections) {
      if (item.kind === 'star') {
        output.push(...scopes[0].columns);
        continue;
      }
      const resolved = this.resolveColumn(scopes, item.table, item.name);
      output.push({ name: item.alias ?? item.name, target: resolved.target });
    }
    return output;
  }

  private resolveColumn(
    scopes: ScopeEntry[],
    table: string | null,
    name: string,
  ): ResolvedColumn {
    if (table !== null) {
      for (let i = 0; i < scopes.length; i++) {
        if (scopes[i].name !== table) continue;
        const column = scopes[i].columns.find((c) => c.name === name);
        if (column === undefined) {
          throw new Error(`Unknown column: ${table}.${name}`);
        }
        return { target: column.target, distance: i };
      }
      throw new Error(`Unknown table reference: ${table}`);
    }
    for (let i = 0; i < scopes.length; i++) {
      const column = scopes[i].columns.find((c) => c.name === name);
      if (column !== undefined) return { target: column.target, distance: i };
    }
    throw new Error(`Unknown column: ${name}`);
  }

  // ----- Constraint extraction -----

  /** Converts a WHERE expression to DNF: a list of OR-branches. */
  private toDnf(
    expr: Expr,
    scopes: ScopeEntry[],
    env: Map<string, CteEntry>,
    path: string,
  ): AtomBranch[] {
    switch (expr.kind) {
      case 'and': {
        let branches: AtomBranch[] = [[]];
        for (const item of expr.items) {
          const inner = this.toDnf(item, scopes, env, path);
          const next: AtomBranch[] = [];
          for (const a of branches) {
            for (const b of inner) next.push([...a, ...b]);
          }
          branches = next;
        }
        return branches;
      }
      case 'or': {
        const branches: AtomBranch[] = [];
        for (const item of expr.items) {
          branches.push(...this.toDnf(item, scopes, env, path));
        }
        return branches;
      }
      case 'exists': {
        // EXISTS constrains nothing in the parent; its inner read instances
        // are diagnosed independently and inner predicates stay inside.
        this.analyzeQuery(expr.query, scopes, env, `${path} > exists`);
        return [[]];
      }
      default: {
        const atom = this.extractAtom(expr, scopes);
        return [atom === null ? [] : [atom]];
      }
    }
  }

  private extractAtom(expr: Expr, scopes: ScopeEntry[]): Atom | null {
    switch (expr.kind) {
      case 'compare':
        return this.extractCompare(expr.op, expr.left, expr.right, scopes);
      case 'between':
        if (expr.negated) return null;
        return this.extractRangeLike(expr.value, expr.low, expr.high, scopes);
      case 'in':
        if (expr.negated) return null;
        return this.localColumnAtom(expr.value, scopes, 'eq');
      case 'isnull':
        if (expr.negated) return null;
        return this.localColumnAtom(expr.value, scopes, 'eq');
      default:
        return null;
    }
  }

  private extractCompare(
    op: CompareOp,
    left: Expr,
    right: Expr,
    scopes: ScopeEntry[],
  ): Atom | null {
    if (op === '<>' || op === '!=') return null;
    const forward = this.compareOnLocalColumn(op, left, right, scopes);
    if (forward !== undefined) return forward;
    const swapped = this.compareOnLocalColumn(SWAP_OP[op], right, left, scopes);
    if (swapped !== undefined) return swapped;
    // Column-to-column comparison within one query block: no constraint.
    return null;
  }

  /** Returns the atom when `columnSide` is a local column and the other side
   *  is a literal or an outer (correlated) column; undefined to try swapped. */
  private compareOnLocalColumn(
    op: CompareOp,
    columnSide: Expr,
    otherSide: Expr,
    scopes: ScopeEntry[],
  ): Atom | null | undefined {
    if (columnSide.kind !== 'column') return undefined;
    const resolved = this.resolveColumn(
      scopes,
      columnSide.table,
      columnSide.name,
    );
    if (resolved.distance !== 0) return undefined;
    if (otherSide.kind === 'column') {
      const other = this.resolveColumn(scopes, otherSide.table, otherSide.name);
      if (other.distance === 0) return null; // same-block column comparison
      // Bound outer column: usable like a constant.
    } else if (otherSide.kind !== 'literal') {
      return null;
    }
    const kind: ConstraintKind = op === '=' ? 'eq' : 'range';
    return { ...resolved.target, kind };
  }

  private extractRangeLike(
    value: Expr,
    low: Expr,
    high: Expr,
    scopes: ScopeEntry[],
  ): Atom | null {
    if (value.kind !== 'column') return null;
    for (const bound of [low, high]) {
      if (bound.kind !== 'literal' && bound.kind !== 'column') return null;
    }
    return this.localColumnAtom(value, scopes, 'range');
  }

  private localColumnAtom(
    value: Expr,
    scopes: ScopeEntry[],
    kind: ConstraintKind,
  ): Atom | null {
    if (value.kind !== 'column') return null;
    const resolved = this.resolveColumn(scopes, value.table, value.name);
    if (resolved.distance !== 0) return null;
    return { ...resolved.target, kind };
  }

  /** Merges one query block's DNF into the affected read instances. */
  private applyBranches(dnf: AtomBranch[]): void {
    const involved = new Set<ReadInstance>();
    for (const branch of dnf) {
      for (const atom of branch) involved.add(atom.instance);
    }
    for (const instance of involved) {
      const incoming: Branch[] = dnf.map((branch) => {
        const map: Branch = new Map();
        for (const atom of branch) {
          if (atom.instance !== instance) continue;
          map.set(atom.column, mergeKind(map.get(atom.column), atom.kind));
        }
        return map;
      });
      const next: Branch[] = [];
      for (const existing of instance.branches) {
        for (const addition of incoming) {
          const merged: Branch = new Map(existing);
          for (const [column, kind] of addition) {
            merged.set(column, mergeKind(merged.get(column), kind));
          }
          next.push(merged);
        }
      }
      instance.branches = next;
    }
  }

  // ----- Reporting -----

  private prefixLength(indexColumns: string[], branch: Branch): number {
    let length = 0;
    for (const column of indexColumns) {
      const kind = branch.get(column);
      if (kind === 'eq') {
        length++;
        continue;
      }
      // A range column is usable as the final prefix column; nothing after it.
      return kind === 'range' ? length + 1 : length;
    }
    return length;
  }

  private toReport(instance: ReadInstance): ReadInstanceReport {
    const indexes: IndexReport[] = instance.table.indexes.map((index) => ({
      index: index.name,
      columns: [...index.columns],
      guaranteedPrefix: Math.min(
        ...instance.branches.map((branch) =>
          this.prefixLength(index.columns, branch),
        ),
      ),
    }));
    const hasFullScanBranch = instance.branches.some((branch) =>
      instance.table.indexes.every(
        (index) => this.prefixLength(index.columns, branch) === 0,
      ),
    );
    return {
      table: instance.table.name,
      alias: instance.alias,
      source: `${instance.path} > ${instance.table.name}`,
      indexes,
      hasFullScanBranch,
    };
  }
}

export function analyzeBatch(
  statements: SelectStmt[],
  tables: TableDef[],
): ReadInstanceReport[] {
  return new Analyzer(tables).analyze(statements);
}
