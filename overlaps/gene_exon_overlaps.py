"""Find genes whose exons overlap exons of other genes, and the introns they share, from a GTF.

nexons assigns each read to the gene/transcript that fits best. Where exons of two genes
overlap, a read can fit both, and the gene it lands on can differ between samples for
reasons other than biology. Differential transcript usage on such genes may then reflect
reads moving between the genes rather than a real change in isoform use. Exon overlap alone
is often resolvable by splice structure; genes that share an intron (the same splice
junction) are the clearer cases of ambiguity. This lists the gene pairs with their shared
introns and exon overlap, so they can be checked, flagged or analysed as one unit.

One row per overlapping gene pair (tab-separated):
  chrom, gene_a, name_a, biotype_a, strand_a, gene_b, name_b, biotype_b, strand_b,
  same_strand    yes/no (for stranded long reads, same-strand overlaps are the ones that can
                 confuse the assignment)
  exons_a        distinct exons of gene A that overlap any exon of gene B
  exons_b        distinct exons of gene B that overlap any exon of gene A
  exon_pairs     overlapping (exon of A, exon of B) pairs
  overlap_bp     bases shared by A's and B's exons (each gene's exons merged first)
  total_exons_a, total_exons_b   distinct exons of each gene, for scale
  shared_introns introns (gap between consecutive exons of a transcript) present in both genes,
                 exactly the same coordinates
  introns_a, introns_b   distinct introns of each gene, for scale
  transcripts_a, transcripts_b   (with --details) transcripts whose exons take part in the
                 overlap, as ID(TSLn[,good]); TSLNA when the GTF has none
Rows are sorted by shared_introns, then overlap_bp, largest first. Every shared intron implies
an exon overlap (the flanking exons share their boundary bases), so pairs sharing introns are
a subset of the overlapping pairs.

Transcripts considered: all of them by default. --max-tsl N applies nexons' rule (nexons.py
read_gtf, also nexons3 and the viewer): a transcript is used if its TSL <= N, or if its
attributes contain one of MANE_Select, Ensembl_Canonical, gencode_primary, gencode_basic
("good"; substring match exactly as nexons, so Ensembl's "Ensembl_canonical" does not match).
Use the same N as the nexons run: overlaps involving only transcripts nexons ignored cannot
make it assign a read to the wrong gene.

Each gene's exons are taken once (the same exon in several transcripts counts once).
Coordinates are compared 0-based half-open ([start - 1, end) from the GTF), so exons that
only touch end to end don't count as overlapping.

Standard library only. Usage:
  python scripts/gene_exon_overlaps.py data/GRCm39.sorted.gtf.gz -o data/GRCm39.exon_overlaps.tsv
  python scripts/gene_exon_overlaps.py genes.gtf --max-tsl 2 --same-strand --details -o tsl2.tsv
  python scripts/gene_exon_overlaps.py genes.gtf --tsl-summary    # one row per Max TSL 1-5, none
"""

import argparse
import csv
import gzip
import re
import sys
from collections import defaultdict
from pathlib import Path

ATTR_RE = re.compile(r'(gene_id|gene_name|gene_biotype|gene_type|transcript_id|transcript_support_level) "([^"]*)"')
GOOD_TAGS = ("MANE_Select", "Ensembl_Canonical", "gencode_primary", "gencode_basic")  # as nexons


def read_exons(path: Path):
    """Genes ({id: {name, biotype, chrom, strand}}), their distinct exons ({id: {exon: set of
    transcript IDs}}) and transcripts ({id: {tsl, good}}), all transcripts."""
    opener = gzip.open if path.suffix == ".gz" else open
    genes, transcripts = {}, {}
    # gene -> exon -> transcripts having it; filtered once every transcript's TSL/tags are known
    exons = defaultdict(lambda: defaultdict(set))
    with opener(path, "rt", encoding="utf-8") as f:
        for line in f:
            if line.startswith("#"):
                continue
            cols = line.rstrip("\n").split("\t")
            if len(cols) < 9 or cols[2] not in ("transcript", "exon"):
                continue
            attrs = dict(ATTR_RE.findall(cols[8]))
            gid = attrs.get("gene_id") or attrs.get("gene_name")
            tid = attrs.get("transcript_id")
            if not gid or not tid:
                continue
            if gid not in genes:
                genes[gid] = {"name": attrs.get("gene_name", gid),
                              "biotype": attrs.get("gene_biotype") or attrs.get("gene_type", ""),
                              "chrom": cols[0], "strand": cols[6]}
            # TSL and tags may sit on the transcript row, the exon rows or both
            t = transcripts.setdefault(tid, {"tsl": None, "good": False})
            m = re.match(r"\d+", attrs.get("transcript_support_level", ""))
            if m and t["tsl"] is None:
                t["tsl"] = int(m.group())
            if not t["good"] and any(tag in cols[8] for tag in GOOD_TAGS):
                t["good"] = True
            if cols[2] == "exon":
                exons[gid][(int(cols[3]) - 1, int(cols[4]))].add(tid)
    return genes, exons, transcripts


def passes_tsl(t, max_tsl):
    """nexons' transcript rule: TSL <= max_tsl or a rescue tag; max_tsl None keeps all."""
    return max_tsl is None or t["good"] or (t["tsl"] is not None and t["tsl"] <= max_tsl)


def filter_exons(exons, transcripts, max_tsl):
    """Exons of the transcripts passing nexons' rule (genes left without any are dropped)."""
    if max_tsl is None:
        return exons
    out = {}
    for gid, by_exon in exons.items():
        kept = {}
        for ex, tids in by_exon.items():
            keep = {t for t in tids if passes_tsl(transcripts[t], max_tsl)}
            if keep:
                kept[ex] = keep
        if kept:
            out[gid] = kept
    return out


def gene_introns(exons):
    """Distinct introns per gene: the gaps between consecutive exons of each transcript."""
    by_tx = defaultdict(list)
    tx_gene = {}
    for gid, by_exon in exons.items():
        for ex, tids in by_exon.items():
            for t in tids:
                by_tx[t].append(ex)
                tx_gene[t] = gid
    introns = defaultdict(set)
    for t, exs in by_tx.items():
        exs.sort()
        for (_, e1), (s2, _) in zip(exs, exs[1:]):
            if e1 < s2:
                introns[tx_gene[t]].add((e1, s2))
    return introns


def tsl_summary(genes, exons, transcripts, same_strand_only, out):
    """One row per Max TSL level (1-5, then none): what nexons would use, what overlaps, and
    which pairs share at least one intron."""
    w = csv.writer(out, delimiter="\t", lineterminator="\n")
    w.writerow(["max_tsl", "transcripts", "genes", "pairs", "same_strand", "pc_pc_same",
                "genes_in_pairs", "genes_same_strand",
                "intron_pairs", "intron_same_strand", "intron_pc_pc_same", "genes_intron_same_strand"])
    for level in (1, 2, 3, 4, 5, None):
        used = filter_exons(exons, transcripts, level)
        introns = gene_introns(used)
        n_tx = sum(passes_tsl(t, level) for t in transcripts.values())
        pairs = find_overlaps(genes, used, same_strand_only)
        is_same = lambda k: genes[k[0]]["strand"] == genes[k[1]]["strand"]
        is_pc = lambda k: genes[k[0]]["biotype"] == genes[k[1]]["biotype"] == "protein_coding"
        same = [k for k in pairs if is_same(k)]
        pc_pc = [k for k in same if is_pc(k)]
        shared = [k for k in pairs if introns[k[0]] & introns[k[1]]]
        shared_same = [k for k in shared if is_same(k)]
        w.writerow(["none" if level is None else level, n_tx, len(used), len(pairs), len(same), len(pc_pc),
                    len({g for k in pairs for g in k}), len({g for k in same for g in k}),
                    len(shared), len(shared_same), sum(map(is_pc, shared_same)),
                    len({g for k in shared_same for g in k})])
        out.flush()


def merge(intervals):
    out = []
    for s, e in sorted(intervals):
        if out and s <= out[-1][1]:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return out


def shared_bp(a, b):
    """Bases covered by both merged interval lists."""
    i = j = total = 0
    while i < len(a) and j < len(b):
        lo, hi = max(a[i][0], b[j][0]), min(a[i][1], b[j][1])
        if lo < hi:
            total += hi - lo
        if a[i][1] < b[j][1]:
            i += 1
        else:
            j += 1
    return total


def find_overlaps(genes, exons, same_strand_only=False):
    """Per gene pair: overlapping exon pairs and the distinct exons involved on each side."""
    by_chrom = defaultdict(list)
    for gid, ivs in exons.items():
        for s, e in ivs:
            by_chrom[genes[gid]["chrom"]].append((s, e, gid))

    pairs = defaultdict(lambda: {"exon_pairs": 0, "exons": defaultdict(set)})
    for items in by_chrom.values():
        items.sort()
        active = []  # exons still open at the current start (end > start)
        for s, e, gid in items:
            active = [x for x in active if x[1] > s]
            for (s2, e2, gid2) in active:
                if gid2 == gid:
                    continue
                if same_strand_only and genes[gid]["strand"] != genes[gid2]["strand"]:
                    continue
                key = tuple(sorted((gid, gid2)))
                p = pairs[key]
                p["exon_pairs"] += 1
                p["exons"][gid].add((s, e))
                p["exons"][gid2].add((s2, e2))
            active.append((s, e, gid))
    return pairs


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("gtf", type=Path, help="GTF (.gtf or .gtf.gz) with exon rows")
    ap.add_argument("-o", "--output", type=Path, help="output TSV (default: standard output)")
    ap.add_argument("--same-strand", action="store_true", help="only pairs on the same strand")
    ap.add_argument("--max-tsl", type=int, metavar="N",
                    help="only transcripts nexons uses at --maxtsl N (TSL <= N or a rescue tag); default all")
    ap.add_argument("--details", action="store_true",
                    help="add transcripts_a/_b: the overlapping transcripts with TSL and rescue tag")
    ap.add_argument("--tsl-summary", action="store_true",
                    help="instead of pairs: one summary row per Max TSL 1-5 and none (rescue tags always apply)")
    args = ap.parse_args()

    genes, all_exons, transcripts = read_exons(args.gtf)
    if args.tsl_summary:
        out = open(args.output, "w", newline="", encoding="utf-8") if args.output else sys.stdout
        try:
            tsl_summary(genes, all_exons, transcripts, args.same_strand, out)
        finally:
            if args.output:
                out.close()
        return 0
    exons = filter_exons(all_exons, transcripts, args.max_tsl)
    introns = gene_introns(exons)
    pairs = find_overlaps(genes, exons, args.same_strand)

    def involved_transcripts(gid, overlapping):
        tids = sorted({t for ex in overlapping for t in exons[gid][ex]})
        return ", ".join(f"{t}(TSL{transcripts[t]['tsl'] if transcripts[t]['tsl'] is not None else 'NA'}"
                         f"{',good' if transcripts[t]['good'] else ''})" for t in tids)
    merged = {}
    rows = []
    for (a, b), p in pairs.items():
        for g in (a, b):
            merged.setdefault(g, merge(exons[g]))
        ga, gb = genes[a], genes[b]
        row = {
            "chrom": ga["chrom"],
            "gene_a": a, "name_a": ga["name"], "biotype_a": ga["biotype"], "strand_a": ga["strand"],
            "gene_b": b, "name_b": gb["name"], "biotype_b": gb["biotype"], "strand_b": gb["strand"],
            "same_strand": "yes" if ga["strand"] == gb["strand"] else "no",
            "exons_a": len(p["exons"][a]), "exons_b": len(p["exons"][b]),
            "exon_pairs": p["exon_pairs"], "overlap_bp": shared_bp(merged[a], merged[b]),
            "total_exons_a": len(exons[a]), "total_exons_b": len(exons[b]),
            "shared_introns": len(introns[a] & introns[b]),
            "introns_a": len(introns[a]), "introns_b": len(introns[b]),
        }
        if args.details:
            row["transcripts_a"] = involved_transcripts(a, p["exons"][a])
            row["transcripts_b"] = involved_transcripts(b, p["exons"][b])
        rows.append(row)
    rows.sort(key=lambda r: (-r["shared_introns"], -r["overlap_bp"], r["chrom"], r["gene_a"]))

    out = open(args.output, "w", newline="", encoding="utf-8") if args.output else sys.stdout
    try:
        w = csv.DictWriter(out, fieldnames=list(rows[0]) if rows else ["chrom"], delimiter="\t", lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    finally:
        if args.output:
            out.close()

    involved = {g for r in rows for g in (r["gene_a"], r["gene_b"])}
    same = sum(r["same_strand"] == "yes" for r in rows)
    used = "all transcripts" if args.max_tsl is None else f"transcripts passing TSL <= {args.max_tsl} or a rescue tag"
    shared = sum(r["shared_introns"] > 0 for r in rows)
    print(f"{len(exons):,} genes with exons ({used}); {len(rows):,} overlapping pairs "
          f"({same:,} same strand) involving {len(involved):,} genes; {shared:,} pairs share an intron",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
