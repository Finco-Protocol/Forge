#!/usr/bin/env perl
# Inject outputSelection into a recovered std-json input, compile, and
# extract the target contract's deployed bytecode. UTF-8 safe end to end.
use strict;
use warnings;
use JSON::PP;

my ($pkg_dir, $name, $work) = @ARGV;
die "usage: std-json-build.pl <pkg-dir> <ContractName> <workdir>\n" unless $pkg_dir && $name && $work;

# 1. Read and fix the input.
open my $in, '<:utf8', "$pkg_dir/std-json-input.json" or die "open input: $!";
local $/;
my $r = JSON::PP->new->decode(<$in>);
close $in;
$r->{settings}{outputSelection} =
  { '*' => { '*' => [ 'evm.bytecode.object', 'evm.deployedBytecode.object' ] } };
my $fixed = JSON::PP->new->canonical->utf8->encode($r);
open my $fo, '>:raw', "$work/$name-std-in-fixed.json" or die $!;
print $fo $fixed;
close $fo;
print "$name: fixed input written (", length($fixed), " bytes)\n";
