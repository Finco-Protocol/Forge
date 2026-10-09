#!/usr/bin/env perl
# Strict parser/gate for `forge lint <path> --json` output (Correction B3).
#
# forge lint --json emits newline-delimited JSON objects, one per
# diagnostic, each with a "level" field ("warning" | "error"; "help" and
# "note" appear only nested inside a diagnostic, never as top-level lines).
#
# Gate semantics (fail closed):
#   exit 0  zero actionable diagnostics (any level other than exactly
#           "note"/"help" is actionable — unknown levels fail)
#   exit 1  at least one actionable diagnostic, or a diagnostic with an
#           unknown level
#   exit 2  malformed JSON, a diagnostic without a "level" field, or an
#           unreadable/missing input file — the gate must never pass on
#           output it could not fully parse
#
# Usage: check-test-lint.pl <lint-output-file>
use strict;
use warnings;
use JSON::PP;

my $file = shift @ARGV or die "usage: check-test-lint.pl <lint-output-file>\n";

open my $fh, '<', $file or do {
  print STDERR "::error::lint gate: cannot read lint output '$file': $!\n";
  print "LINT_GATE_VERDICT=MALFORMED\n";
  exit 2;
};

my $diagnostics = 0;
my $actionable  = 0;

while (my $line = <$fh>) {
  next if $line =~ /^\s*$/;

  my $data = eval { JSON::PP->new->decode($line) };
  if ($@) {
    print STDERR "::error::lint gate: malformed JSON in lint output (line $.): $@\n";
    print "LINT_GATE_VERDICT=MALFORMED\n";
    exit 2;
  }
  if (ref $data ne 'HASH' || !exists $data->{level}) {
    print STDERR "::error::lint gate: lint output line $. is not a diagnostic object with a 'level' field\n";
    print "LINT_GATE_VERDICT=MALFORMED\n";
    exit 2;
  }

  $diagnostics++;
  my $level = $data->{level};

  # Fail closed: only explicitly non-actionable levels are tolerated;
  # anything else — including unknown future levels — blocks the gate.
  if ($level ne 'note' && $level ne 'help') {
    $actionable++;
    my $code = (ref $data->{code} eq 'HASH' && defined $data->{code}{code}) ? $data->{code}{code} : 'unknown';
    my ($span_file, $span_line) = ('no-location', '?');
    if (ref $data->{spans} eq 'ARRAY' && ref $data->{spans}[0] eq 'HASH') {
      $span_file = $data->{spans}[0]{file_name} // 'no-location';
      $span_line = defined $data->{spans}[0]{line_start} ? $data->{spans}[0]{line_start} : '?';
    }
    print STDERR "::error::lint gate: finding [$level/$code] at $span_file:$span_line\n";
  }
}

close $fh or do {
  print STDERR "::error::lint gate: error closing lint output: $!\n";
  print "LINT_GATE_VERDICT=MALFORMED\n";
  exit 2;
};

if ($actionable) {
  print "LINT_GATE_VERDICT=FAIL (diagnostics=$diagnostics actionable=$actionable)\n";
  exit 1;
}
print "LINT_GATE_VERDICT=PASS (diagnostics=0 actionable=0)\n";
exit 0;
