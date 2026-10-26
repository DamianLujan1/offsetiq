// Columnar data shapes exported by pipeline/export_web.py. All values are real
// RRC-derived numbers; null means "not available" and is never silently ranked.
export type N = number | null;

export interface Wells {
  n: number;
  api10: string[]; lease: string[]; lease_no: string[]; well_no: string[];
  operator: string[]; field: string[]; county: string[];
  lat: number[]; lon: number[]; slat: number[]; slon: number[]; blat: number[]; blon: number[];
  lat_ft: number[]; az: number[];
  first: number[]; last: number[]; months: number[];
  cum_oil: number[]; cum_gas: number[]; cum6: N[]; cum12: N[]; cum24: N[];
  status: string[]; qi: N[]; peak_mop: N[]; Di: N[]; b: N[]; r2: N[];
  eur: N[]; rem: N[]; eur_kft: N[]; cluster: string[]; conf: string[];
  e_known: N[]; e_qi: N[]; e_Di: N[]; e_b: N[]; e_cl: N[];
}

export interface Horizontals {
  api10: string[]; lat: number[]; lon: number[]; lat_ft: N[]; code: number[];
  county: string[]; labels: string[];
}

export interface CompactModel { features: string[]; trees: number[][][] }
export type ModelBundle = Record<string, CompactModel>;

export interface Monthly { [api10: string]: { oil: number[]; mop: number[]; ym: number[] } }
