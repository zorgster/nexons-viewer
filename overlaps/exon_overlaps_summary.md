# Gene pairs sharing introns in GRCm39, by nexons Max TSL

Gene pairs where nexons could potentially assign a read to either gene, counted at each
`--maxtsl` setting: pairs whose exons overlap, and the subset that share an intron (identical
splice junction), where splice structure can't tell them apart. Relevant to DTU calls in those
genes. This is an analysis of the GTF only.

## Method

- Ensembl 116 GRCm39 GTF (78,348 genes, 481,956 transcripts).
- Transcripts per level as in nexons' `read_gtf`: TSL ≤ N or one of the rescue tags
  (`MANE_Select`, `Ensembl_Canonical`, `gencode_primary`, `gencode_basic`, substring match).
  TSL is the leading number ("3 (lowered from 2)" → 3); `NA` counts as none.
- Distinct exons and introns pooled per gene. A pair overlaps if any exon of one overlaps any
  exon of the other by at least 1 bp (end-to-end contact doesn't count); it shares an intron if
  both genes have an intron with the same coordinates.

## Results

| Max TSL | Transcripts used | Same-strand exon overlap: pairs | genes | Same-strand shared intron: pairs | of which protein-coding/protein-coding | genes |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 268,283 | 4,825 | 7,817 | 1,443 | 823 | 1,748 |
| 2 | 279,606 | 4,897 | 7,927 | 1,459 | 835 | 1,778 |
| 3 | 295,050 | 4,953 | 8,025 | 1,472 | 844 | 1,800 |
| 4 | 295,051 | 4,953 | 8,025 | 1,472 | 844 | 1,800 |
| 5 | 307,859 | 4,992 | 8,091 | 1,481 | 851 | 1,816 |
| none | 481,956 | 5,208 | 8,454 | 1,516 | 857 | 1,879 |

Opposite-strand overlaps are left out (about 14,450–16,100 pairs depending on level); fewer
than 15 opposite-strand pairs share an intron at any level.

## Notes

- The TSL setting makes little difference: from TSL 1 to no filter adds 213,673 transcripts but
  only 73 shared-intron pairs (+5%). Every gene keeps at least one transcript at TSL 1.
- At the default `--maxtsl 2`, 1,459 same-strand pairs share an intron, involving 1,778 genes
  (~2.3%); 835 are protein-coding/protein-coding. Exon overlap alone gives 4,897 pairs and
  7,927 genes. The pairs that overlap without a common junction include small-RNA genes
  inside host exons (about a quarter of them, no filter), the rest being partial exon
  overlaps.
- Examples (no filter): Srcap / Gm42715 (28 shared introns), Cmtr1 / Gm28043 (20),
  Zbed6 / Zc3h11a (all 16 Zbed6 introns), Rpp14 / Htd2 (3). 102 of the pairs are two Ensembl
  gene IDs with the same name (e.g. Pakap, Ptp4a1), which `nG` can split. More in
  `exon_overlaps_top_pairs.md`.
- Possible handling: flag DTU calls in genes in shared-intron pairs, or pool each pair (or
  connected group) and test usage across the combined transcript set.
- The rescue list's `Ensembl_Canonical` doesn't match Ensembl's spelling `Ensembl_canonical`.
  Probably no effect in practice: the canonical transcripts checked also carry
  `gencode_primary` / `gencode_basic`.

## Reproduce

```
python scripts/gene_exon_overlaps.py <gtf or gtf.gz> --tsl-summary          # this table
python scripts/gene_exon_overlaps.py <gtf> -o pairs.tsv                       # all pairs
python scripts/gene_exon_overlaps.py <gtf> --max-tsl 2 --same-strand --details -o tsl2.tsv
#   one row per gene pair: shared introns, exon pairs, distinct exons per gene, shared bp,
#   strand, biotypes; --details adds the overlapping transcripts as ID(TSLn[,good])
```

GRCm39 outputs in `nexons4/data/`: `GRCm39.exon_overlaps.tsv` (all pairs, no filter) and
`GRCm39.exon_overlaps.tsl_summary.tsv` (this table, with all columns).
