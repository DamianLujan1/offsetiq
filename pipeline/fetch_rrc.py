"""Step 1 — download public Texas RRC bulk data and extract the 3-county slice.

Sources (all public, no login), from the RRC "Data Sets Available for Download" page
https://www.rrc.texas.gov/resource-center/research/data-sets-available-for-download/

  * Production Data Query dump (PDQ_DSV.zip, ~3.6 GB, monthly refresh)
      https://mft.rrc.texas.gov/link/1f5ddb8d-329a-4459-b7f8-177b4f5ee60d
  * Well layers by county (ArcView shapefiles: surface, bottom-hole, and
    surface->bottom-hole lateral lines), daily refresh
      https://mft.rrc.texas.gov/link/d551fb20-442e-4b67-84fa-ac3f23ecabb4

The RRC MFT site is a GoAnywhere "public GoDrive" share; files are fetched by
replaying the same form POST the browser makes when you click a filename.

Usage:  python pipeline/fetch_rrc.py [--raw data/raw] [--skip-pdq]
Outputs in data/raw/:
  wellNNN.zip                      county well layers (003 Andrews, 135 Ector,
                                   329 Midland, 317 Martin)
  wellcomp.dsv                     OG_WELL_COMPLETION_DATA_TABLE (all TX)
  lease_cycle_target.dsv           OG_LEASE_CYCLE_DATA_TABLE rows for oil leases
                                   with a completion in the target counties, 2012+
"""
from __future__ import annotations

import argparse
import csv
import io
import os
import re
import subprocess
import zipfile

import requests

PDQ_LINK = "https://mft.rrc.texas.gov/link/1f5ddb8d-329a-4459-b7f8-177b4f5ee60d"
WELL_LAYER_LINK = "https://mft.rrc.texas.gov/link/d551fb20-442e-4b67-84fa-ac3f23ecabb4"
COUNTY_CODES = {"003": "ANDREWS", "135": "ECTOR", "329": "MIDLAND", "317": "MARTIN"}


def mft_download(link: str, wanted: list[str], outdir: str) -> list[str]:
    s = requests.Session()
    s.headers["User-Agent"] = "Mozilla/5.0 (OffsetIQ data refresh)"
    h = s.get(link, timeout=120).text
    form = re.search(r'<form id="fileList"(.*?)</form>', h, re.S).group(0)
    action = re.search(r'action="([^"]+)"', form).group(1)
    vs = re.search(r'name="javax.faces.ViewState"[^>]*value="([^"]+)"', form).group(1)
    out = []
    for _ri, row in re.findall(r'<tr[^>]*data-ri="(\d+)"[^>]*>(.*?)</tr>', h, re.S):
        name = re.sub(r"\s+", " ", re.sub("<[^>]+>", " ", row)).strip().split(" ")[0]
        if name not in wanted:
            continue
        key = re.search(r"addSubmitParam\('fileList',\{'([^']+)'", row).group(1)
        data = {"fileList_SUBMIT": "1", "javax.faces.ViewState": vs, key: key}
        r = s.post("https://mft.rrc.texas.gov" + action, data=data, timeout=3600, stream=True)
        r.raise_for_status()
        path = os.path.join(outdir, name)
        with open(path, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
        print(f"downloaded {name} ({os.path.getsize(path)/1e6:,.1f} MB)", flush=True)
        out.append(path)
    return out


def extract_pdq(raw: str) -> None:
    pdq = os.path.join(raw, "PDQ_DSV.zip")
    with zipfile.ZipFile(pdq) as z:
        with z.open("OG_WELL_COMPLETION_DATA_TABLE.dsv") as src, open(
            os.path.join(raw, "wellcomp.dsv"), "wb"
        ) as dst:
            dst.write(src.read())
    # Lease keys (district, lease) for oil completions in target counties.
    keys = set()
    with open(os.path.join(raw, "wellcomp.dsv"), encoding="latin-1") as f:
        rd = csv.DictReader(f, delimiter="}")
        for r in rd:
            if r["OIL_GAS_CODE"] == "O" and r["API_COUNTY_CODE"] in COUNTY_CODES:
                keys.add(f'{r["DISTRICT_NO"]}}}{r["LEASE_NO"]}')
    keyfile = os.path.join(raw, "target_leases.txt")
    with open(keyfile, "w") as f:
        f.write("\n".join(sorted(keys)) + "\n")
    # Stream the 12.9 GB lease-cycle table through awk (fast, constant memory).
    cmd = (
        f"unzip -p {pdq} OG_LEASE_CYCLE_DATA_TABLE.dsv | "
        "awk -F'}' 'NR==FNR{k[$1\"}\"$2]=1;next} FNR==1{print;next} "
        "$1==\"O\" && $4>=2012 && (($2\"}\"$3) in k)' "
        f"{keyfile} - > {os.path.join(raw, 'lease_cycle_target.dsv')}"
    )
    subprocess.run(cmd, shell=True, check=True)
    print("extracted lease_cycle_target.dsv", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", default="data/raw")
    ap.add_argument("--skip-pdq", action="store_true")
    a = ap.parse_args()
    os.makedirs(a.raw, exist_ok=True)
    mft_download(WELL_LAYER_LINK, [f"well{c}.zip" for c in COUNTY_CODES], a.raw)
    if not a.skip_pdq:
        mft_download(PDQ_LINK, ["PDQ_DSV.zip"], a.raw)
    extract_pdq(a.raw)


if __name__ == "__main__":
    main()
