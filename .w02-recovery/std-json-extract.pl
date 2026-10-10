#!/usr/bin/env perl
# Extract the named contract's deployed bytecode object from a solc
# --standard-json output file. UTF-8 safe.
use strict;
use warnings;
use JSON::PP;

my ($out_file, $want) = @ARGV;
die "usage: std-json-extract.pl <solc-output.json> <ContractName>\n" unless $out_file && $want;

open my $in, '<:raw', $out_file or die "open $out_file: $!";
local $/;
my $r = JSON::PP->new->utf8->decode(<$in>);
close $in;

my $found;
for my $f (keys %{ $r->{contracts} // {} }) {
  for my $cn (keys %{ $r->{contracts}{$f} }) {
    $found = $r->{contracts}{$f}{$cn} if $cn eq $want;
  }
}
if ($found) {
  my $o = $found->{evm}{deployedBytecode}{object} // '';
  $o =~ s/^0x//;
  open my $o1, '>:raw', "$want-runtime.txt" or die $!;
  print $o1 $o;
  close $o1;
  my $c = $found->{evm}{bytecode}{object} // '';
  $c =~ s/^0x//;
  open my $o2, '>:raw', "$want-creation.txt" or die $!;
  print $o2 $c;
  close $o2;
  print "$want: runtime ", length($o), " chars, creation ", length($c), " chars\n";
} else {
  print "$want: NOT FOUND (compile failed?)\n";
  for my $e (@{ $r->{errors} // [] }) {
    my $sev = $e->{severity} // '?';
    next if $sev eq 'warning';
    print "  [$sev] ", substr(($e->{formattedMessage} // $e->{message} // ''), 0, 200), "\n";
  }
  exit 1;
}
