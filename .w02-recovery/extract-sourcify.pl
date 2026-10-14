#!/usr/bin/env perl
# Extract the verified deploy-time source tree from a Sourcify v2
# `?fields=all` API record: writes sources/, metadata.json, std-json
# input/output, and the byte-comparison facts into a per-contract dir.
use strict;
use warnings;
use JSON::PP;

my ($json_file, $out_dir) = @ARGV;
die "usage: extract-sourcify.pl <record.json> <outdir>\n" unless $json_file && $out_dir;

open my $fh, '<', $json_file or die "open $json_file: $!";
local $/;
my $rec = JSON::PP->new->decode(<$fh>);
close $fh;

mkdir $out_dir unless -d $out_dir;

# 1. Source files (v2 API: map of path -> {content, ...})
my $n = 0;
my $srcs = $rec->{sources} // {};
if (ref $srcs eq 'HASH') {
  for my $path (sort keys %$srcs) {
    my $full = "$out_dir/$path";
    my ($dir) = $full =~ m{^(.*/)[^/]+$};
    system('mkdir', '-p', $dir) unless -d $dir;
    open my $o, '>', $full or die "write $full: $!";
    print $o ($srcs->{$path}{content} // '');
    close $o;
    $n++;
  }
} elsif (ref $srcs eq 'ARRAY') {
  for my $src (@$srcs) {
    my $path = $src->{path} or next;
    my $full = "$out_dir/$path";
    my ($dir) = $full =~ m{^(.*/)[^/]+$};
    system('mkdir', '-p', $dir) unless -d $dir;
    open my $o, '>', $full or die "write $full: $!";
    print $o ($src->{content} // '');
    close $o;
    $n++;
  }
}
print "sources written: $n\n";

# 2. Metadata + compilation facts
if ($rec->{metadata}) {
  open my $m, '>', "$out_dir/metadata.json" or die $!;
  print $m JSON::PP->new->canonical->pretty->encode($rec->{metadata});
  close $m;
}
if ($rec->{compilation}) {
  open my $c, '>', "$out_dir/compilation.json" or die $!;
  print $c JSON::PP->new->canonical->pretty->encode($rec->{compilation});
  close $c;
}

# 3. Standard-json input / output (exact reproducible compilation)
for my $pair (['stdJsonInput', 'std-json-input.json'], ['stdJsonOutput', 'std-json-output.json']) {
  my ($key, $file) = @$pair;
  next unless $rec->{$key};
  open my $s, '>', "$out_dir/$file" or die $!;
  print $s JSON::PP->new->canonical->encode($rec->{$key});
  close $s;
}

# 4. Byte comparison facts + deployment provenance
my $rb = $rec->{runtimeBytecode} // {};
my $cb = $rec->{creationBytecode} // {};
my $dep = $rec->{deployment} // {};
open my $f, '>', "$out_dir/byte-comparison.json" or die $!;
print $f JSON::PP->new->canonical->pretty->encode({
  matchId       => $rec->{matchId},
  verifiedAt    => $rec->{verifiedAt},
  runtimeMatch  => $rec->{runtimeMatch},
  creationMatch => $rec->{creationMatch},
  runtimeOnchain   => $rb->{onchainBytecode},
  runtimeRecompiled=> $rb->{recompiledBytecode},
  creationOnchain  => $cb->{onchainBytecode},
  creationRecompiled=> $cb->{recompiledBytecode},
  deployment    => $dep,
});
close $f;
print "extraction complete: $out_dir\n";
