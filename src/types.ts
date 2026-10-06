/** 门店资料：周一至周日 7 个字符串的营业时间。 */
export interface Profile {
  businessName: string;
  address: string;
  phone: string;
  hours: string[];
}

export type ProfileField = 'businessName' | 'address' | 'phone' | 'hours';

/** 单个字段的差异，携带 canonical 与 listing 两侧的值。 */
export interface FieldDiff {
  field: ProfileField;
  canonicalValue: string | string[];
  listingValue: string | string[];
}

/** 一个目录的评分结果。 */
export interface DirectoryReport {
  directory: string;
  score: number;
  diffs: FieldDiff[];
}

/** 评分函数的输入快照。 */
export interface ScoreInput {
  locationId: string;
  directory: string;
  revision: number;
  canonical: Profile;
  listing: Profile;
}

export interface DirectoryScore {
  score: number;
  diffs: FieldDiff[];
}

/** 可注入的异步评分函数。 */
export type ScoreFn = (input: ScoreInput) => Promise<DirectoryScore>;

export interface ReadyReport {
  status: 'ready';
  locationId: string;
  revision: number;
  canonical: Profile;
  listings: Record<string, Profile>;
  directories: DirectoryReport[];
}

export interface PendingReport {
  status: 'pending';
  locationId: string;
  revision: number;
}

export type Report = ReadyReport | PendingReport;
