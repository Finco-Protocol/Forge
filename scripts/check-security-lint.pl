#!/usr/bin/env perl
# Strict gate for `forge lint <security-contracts> --json` (Correction B).
#
# Unlike the test-code gate (scripts/check-test-lint.pl, required zero), the
# Forge-authored eligibility stack carries a small set of REVIEWED advisory
# warnings. They are pinned, one by one, in a baseline file; everything
# else fails. The ENTIRE lint output is parsed as newline-delimited JSON —
# there is no regex/grep prefilter in front of this parser.
#
# Baseline format (tab-separated, '#' comments and blank lines ignored):
#   <code> TAB <file> TAB <count> TAB <anchor> TAB <rationale>
# <anchor> is the trimmed source text of the diagnostic's primary span
# (first line), so a pin follows the code it approves rather than a line
# number, and stops matching as soon as that code changes. <count> is the
# exact number of occurrences approved.
#
# Gate semantics (fail closed):
#   exit 0  zero errors; every warning matches a pin; every pin is matched
#           exactly <count> times
#   exit 1  any error-level diagnostic (errors are never pinnable), any
#           unknown level, any unexpected warning, any pin count mismatch
#           or stale (unmatched) pin
#   exit 2  malformed lint JSON, a non-diagnostic object, a warning without
#           a primary span, an unreadable input, or a malformed baseline
#
# Usage: check-security-lint.pl <lint-output.json> <baseline.tsv>
use strict;
use warnings;
use JSON::PP;

sub malformed {
  my ($msg) = @_;
  print STDERR "::error::security lint gate: $msg\n";
  print "SECURITY_LINT_VERDICT=MALFORMED\n";
  exit 2;
}

my ($lint_file, $baseline_file) = @ARGV;
malformed("usage: check-security-lint.pl <lint-output.json> <baseline.tsv>")
  unless defined $lint_file && defined $baseline_file && @ARGV == 2;

# ── Baseline ─────────────────────────────────────────────────────────────
open my $bf, '<', $baseline_file or malformed("cannot read baseline '$baseline_file': $!");
my %pins;  # key -> { count, rationale, seen }
my @pin_order;
while (my $l = <$bf>) {
  chomp $l;
  $l =~ s/\r$//;
  next if $l =~ /^\s*(#|$)/;
  my @f = split /\t/, $l, -1;
  malformed("baseline line $.: expected 5 tab-separated fields, got " . scalar(@f)) unless @f == 5;
  my ($code, $file, $count, $anchor, $rationale) = @f;
  malformed("baseline line $.: empty code/file/anchor") if grep { !length } ($code, $file, $anchor);
  malformed("baseline line $.: count must be a positive integer") unless $count =~ /^[1-9][0-9]*$/;
  malformed("baseline line $.: rationale required") unless $rationale =~ /\S/;
  my $key = join "\x1f", $code, $file, $anchor;
  malformed("baseline line $.: duplicate pin") if exists $pins{$key};
  $pins{$key} = { code => $code, file => $file, anchor => $anchor, count => $count,
                  rationale => $rationale, seen => 0, lines => [] };
  push @pin_order, $key;
}
close $bf;

# ── Lint output: every non-blank line must be a diagnostic object ────────
open my $fh, '<', $lint_file or malformed("cannot read lint output '$lint_file': $!");
my $json = JSON::PP->new;
my ($errors, $warnings, $unexpected, $diagnostics) = (0, 0, 0, 0);
while (my $line = <$fh>) {
  next if $line =~ /^\s*$/;
  my $d = eval { $json->decode($line) };
  malformed("malformed JSON in lint output (line $.): $@") if $@;
  malformed("lint output line $. is not a JSON object") unless ref $d eq 'HASH';
  my $mt = $d->{'$message_type'};
  malformed("lint output line $. is not a diagnostic (\$message_type=" . ($mt // 'missing') . ")")
    unless defined $mt && $mt eq 'diagnostic';
  malformed("lint output line $. has no 'level' field") unless defined $d->{level};
  $diagnostics++;

  my $level = $d->{level};
  my $code = (ref $d->{code} eq 'HASH' && defined $d->{code}{code}) ? $d->{code}{code} : undef;
  my ($span) = grep { ref $_ eq 'HASH' && $_->{is_primary} } @{ ref $d->{spans} eq 'ARRAY' ? $d->{spans} : [] };
  my $where = $span ? ($span->{file_name} // '?') . ':' . ($span->{line_start} // '?') : 'no-location';
  my $label = $code // 'unknown';

  if ($level eq 'error') {
    $errors++;
    print STDERR "::error::security lint gate: ERROR [$label] at $where (errors are never pinnable)\n";
    next;
  }
  if ($level ne 'warning') {
    $unexpected++;
    print STDERR "::error::security lint gate: unknown level '$level' [$label] at $where (fail closed)\n";
    next;
  }
  $warnings++;
  malformed("warning on line $. has no code") unless defined $code;
  malformed("warning [$code] on line $. has no primary span") unless $span;
  my $text = (ref $span->{text} eq 'ARRAY' && ref $span->{text}[0] eq 'HASH') ? $span->{text}[0]{text} : undef;
  malformed("warning [$code] at $where has no source text") unless defined $text;
  (my $anchor = $text) =~ s/^\s+|\s+$//g;
  my $key = join "\x1f", $code, $span->{file_name}, $anchor;
  if (exists $pins{$key}) {
    $pins{$key}{seen}++;
    push @{ $pins{$key}{lines} }, $span->{line_start};
  } else {
    $unexpected++;
    print STDERR "::error::security lint gate: UNEXPECTED warning [$code] at $where: $anchor\n";
  }
}
close $fh or malformed("error closing lint output: $!");

# ── Pins: exact counts, no stale entries; report every approved finding ─
my ($approved, $mismatched) = (0, 0);
for my $key (@pin_order) {
  my $p = $pins{$key};
  if ($p->{seen} != $p->{count}) {
    $mismatched++;
    my $kind = $p->{seen} == 0 ? 'STALE pin (no longer reported)' : 'pin COUNT MISMATCH';
    print STDERR "::error::security lint gate: $kind [$p->{code}] $p->{file}: expected $p->{count}, found $p->{seen}: $p->{anchor}\n";
    next;
  }
  $approved += $p->{seen};
  my $lines = join ',', @{ $p->{lines} };
  print "APPROVED_ADVISORY [$p->{code}] $p->{file}:$lines x$p->{count} - $p->{rationale}\n";
}

my $summary = "diagnostics=$diagnostics errors=$errors warnings=$warnings approved=$approved "
  . "unexpected=$unexpected pin_mismatches=$mismatched pins=" . scalar(@pin_order);
if ($errors || $unexpected || $mismatched) {
  print "SECURITY_LINT_VERDICT=FAIL ($summary)\n";
  exit 1;
}
print "SECURITY_LINT_VERDICT=PASS ($summary)\n";
exit 0;
