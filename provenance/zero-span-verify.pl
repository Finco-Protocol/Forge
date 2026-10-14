#!/usr/bin/env perl
# Rigorous bytecode parity verification without solc immutableReferences
# (absent under via_ir). Algorithm:
#   1. Locate each string's CBOR auxdata tail as the LAST occurrence of
#      the ipfs marker whose trailing 2-byte length word is consistent
#      (deployer-type contracts embed creation codes that contain the
#      marker byte pattern as raw data).
#   2. Walk template-vs-deployed diffs within the code portions; expand
#      every diff span outward to the enclosing maximal all-zero run in
#      the TEMPLATE and require the expanded run to be exactly 40 hex
#      chars (20-byte immutable address placeholder). Record values.
#   3. Patch all runs with the deployed values; require the code portions
#      to be FULLY equal.
#   4. Verify both tails: equal length.
# Exit 0 only on full parity under this handling.
use strict;
use warnings;

my ($recompiled_file, $onchain_file, $name) = @ARGV;
die "usage: zero-span-verify.pl <recompiled-runtime.txt> <onchain.txt> <name>\n"
  unless $recompiled_file && $onchain_file && $name;

sub slurp_hex {
  my ($f) = @_;
  open my $fh, '<:raw', $f or die "open $f: $!";
  local $/;
  my $s = <$fh>;
  close $fh;
  $s =~ s/^\s+|\s+$//g;
  $s =~ s/^0x//;
  die "$f is empty\n" unless length $s;
  return $s;
}

my $marker = "a2646970667358221220";    # a1 64 "ipfs" 58 22 <32-byte sha256>

sub find_tail {
  my ($s, $nm) = @_;
  my $pos = rindex($s, $marker);
  while ($pos >= 0) {
    my $tail = substr($s, $pos);
    my $len_word = hex(substr($tail, -4));
    return $pos if $len_word == length($tail) / 2 - 2;
    $pos = rindex($s, $marker, $pos - 1);
  }
  die "$nm: no CBOR tail with consistent length word found\n";
}

my $tpl = slurp_hex($recompiled_file);
my $dep = slurp_hex($onchain_file);

my $ia = find_tail($tpl, "$name (template)");
my $ib = find_tail($dep, "$name (deployed)");

my $code_tpl = substr($tpl, 0, $ia);
my $code_dep = substr($dep, 0, $ib);
my $tail_tpl = substr($tpl, $ia);
my $tail_dep = substr($dep, $ib);

die "$name: code length mismatch (template ", length($code_tpl),
  " vs deployed ", length($code_dep), ")\n"
  unless length($code_tpl) == length($code_dep);

# 1. Differing spans within code portions.
my @spans;
my $i = 0;
my $n = length($code_tpl);
while ($i < $n) {
  if (substr($code_tpl, $i, 1) eq substr($code_dep, $i, 1)) { $i++; next; }
  my $start = $i;
  $i++ while $i < $n && substr($code_tpl, $i, 1) ne substr($code_dep, $i, 1);
  push @spans, [ $start, $i - $start ];
}

# 2. Expand each merged span to the enclosing all-zero template run.
my @merged;
for my $s (@spans) {
  if (@merged && $merged[-1][0] + $merged[-1][1] == $s->[0]) { $merged[-1][1] += $s->[1]; }
  else { push @merged, [ @$s ]; }
}

my @values;
my $patched = $code_tpl;
for my $m (@merged) {
  my ($off, $len) = @$m;
  my $lo = $off;
  $lo-- while $lo > 0 && substr($code_tpl, $lo - 1, 1) eq '0' && ($off + $len - $lo) < 40;
  my $hi = $off + $len;
  $hi++ while $hi < $n && substr($code_tpl, $hi, 1) eq '0' && ($hi - $lo) < 40;
  my $runlen = $hi - $lo;
  unless ($runlen == 40 && substr($code_tpl, $lo, 40) =~ /^0+$/) {
    printf "%s: SPAN at hex-offset %d (len %d) does not expand to a 40-hex zero run (expanded to %d at %d)\n",
      $name, $off, $len, $runlen, $lo;
    exit 1;
  }
  my $val = substr($code_dep, $lo, 40);
  push @values, "0x$val\@" . ($lo / 2);
  substr($patched, $lo, 40) = $val;
}

# 3. Full code equality after patching.
if ($patched ne $code_dep) {
  for my $i (0 .. length($patched) - 1) {
    if (substr($patched, $i, 1) ne substr($code_dep, $i, 1)) {
      printf "%s: CODE STILL DIFFERS at hex-offset %d\n  patched: %s\n  deployed: %s\n",
        $name, $i, substr($patched, $i, 60), substr($code_dep, $i, 60);
      exit 1;
    }
  }
}

# 4. Tail sanity.
die "$name: tail length differs (template ", length($tail_tpl), " vs deployed ",
  length($tail_dep), ")\n" unless length($tail_tpl) == length($tail_dep);

printf "%s: RUNTIME-PARITY-PROVEN immutable_spans=%d code_bytes=%d metadata_tail_bytes=%d\n",
  $name, scalar(@merged), length($code_dep) / 2, length($tail_dep) / 2;
exit 0;
