#!/usr/bin/env perl
# Byte-verify a recompiled deployedBytecode against on-chain runtime code,
# accounting for immutable variables: solc's immutableReferences map gives
# each immutable's byte offset/length in the runtime template. This script
# reads the on-chain values at those offsets and patches them into the
# template, then compares full byte equality and reports per-immutable
# values.
use strict;
use warnings;
use JSON::PP;

my ($std_out_file, $contract, $runtime_file, $onchain_file) = @ARGV;
die "usage: immutable-patch-verify.pl <std-out.json> <Contract> <recompiled-runtime.txt> <onchain-runtime.txt>\n"
  unless $std_out_file && $contract && $runtime_file && $onchain_file;

open my $fh, '<:raw', $std_out_file or die "open: $!";
local $/;
my $r = JSON::PP->new->utf8->decode(<$fh>);
close $fh;

my $refs;
for my $f (keys %{ $r->{contracts} // {} }) {
  for my $cn (keys %{ $r->{contracts}{$f} }) {
    $refs = $r->{contracts}{$f}{$cn}{evm}{deployedBytecode}{immutableReferences} if $cn eq $contract;
  }
}
open my $rf, '<:raw', $runtime_file or die $!;
my $recompiled = <$rf>; close $rf; chomp $recompiled; $recompiled =~ s/^0x//;
open my $of, '<:raw', $onchain_file or die $!;
my $onchain = <$of>; close $of; chomp $onchain; $onchain =~ s/^0x//;

die "length mismatch: recompiled ", length($recompiled), " vs onchain ", length($onchain), "\n"
  unless length($recompiled) == length($onchain);

my %immutables;
my $patched = $recompiled;
for my $id (keys %{ $refs // {} }) {
  for my $span (@{ $refs->{$id} }) {
    my ($start, $len) = ($span->{start} * 2, $span->{length} * 2);
    my $deployed_val = substr($onchain, $start, $len);
    my $template_val = substr($recompiled, $start, $len);
    $immutables{$id} = "0x$deployed_val";
    substr($patched, $start, $len) = $deployed_val;
    if ($template_val =~ /^0+$/) {
      # zero placeholder as expected
    } elsif ($template_val ne $deployed_val) {
      print "WARN immutable $id: template $template_val != deployed $deployed_val (not a zero placeholder)\n";
    }
  }
}

if ($patched eq $onchain) {
  print "IMMUTABLE-PATCHED-BYTE-EXACT immutables=",
    JSON::PP->new->canonical->encode(\%immutables), "\n";
  exit 0;
} else {
  my $n = length($patched);
  for my $i (0 .. $n - 1) {
    if (substr($patched, $i, 1) ne substr($onchain, $i, 1)) {
      printf "STILL-DIFFERS at hex-offset %d\n", $i;
      printf " patched: %s\n onchain: %s\n", substr($patched, $i, 60), substr($onchain, $i, 60);
      exit 1;
    }
  }
  print "LENGTH-ONLY-DIFF? recomp=", length($patched), " onchain=", length($onchain), "\n";
  exit 1;
}
