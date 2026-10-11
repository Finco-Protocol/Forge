#!/usr/bin/env perl
# Full-tree integrity check (Correction A / P1-4): the union of all
# Sourcify-verified std-json compile sets must cover the deploy-time tree —
# every .sol file present in a verified compile set must exist in the tree
# and match at least one Sourcify-verified revision (compile sets differ
# across the deploy-time packages); every tree .sol file must be covered by
# at least one verified compile set or the documented forge-additions
# allowlist. forge-std test helpers excluded.
use strict;
use warnings;
use JSON::PP;
use Digest::SHA qw(sha256_hex);

my ($tree_root, @std_jsons) = @ARGV;
die "usage: tree-integrity.pl <tree-root> <forge-additions.txt> <std-json-input.json>...\n"
  unless $tree_root && @std_jsons >= 2;

my $additions_file = shift @std_jsons;
my %embedded;     # rel path -> 1
my %contents;     # rel path -> { sha256(content) -> 1 }
my %representative; # rel path -> one embedded content

# forge-additions allowlist: documented OZ v5.0.0 files added for the Forge
# stack (docs/MODIFICATION-REGISTER.md §4), pinned by sha256.
open my $af, '<:raw', $additions_file
  or die "open additions allowlist $additions_file: $!";
my %additions;    # treerel -> pinned sha256
while (my $l = <$af>) {
  chomp $l;
  next if $l =~ /^\s*$/;
  my ($h, $rel) = split /\s+/, $l;
  $additions{$rel} = $h;
}
close $af;

for my $std_json (@std_jsons) {
  open my $in, '<:raw', $std_json or die "open $std_json: $!";
  local $/;
  my $r = JSON::PP->new->utf8->decode(<$in>);
  close $in;
  for my $path (sort keys %{ $r->{sources} // {} }) {
    (my $rel = $path) =~ s{^contracts/}{};
    $embedded{$rel} = 1;
    my $content = $r->{sources}{$path}{content} // '';
    utf8::encode(my $bytes = $content);
    my $h = sha256_hex($bytes);
    $contents{$rel}{$h} = 1;
    $representative{$rel} = $content;
  }
}

my $fail = 0;

# 1. Every verified source exists in the tree and matches at least one
#    Sourcify-verified revision.
for my $rel (sort keys %embedded) {
  my $disk = "$tree_root/$rel";
  if (!-f $disk) {
    print "::error::tree integrity: source MISSING from deploy-time tree: $rel\n";
    $fail = 1;
    next;
  }
  open my $fh, '<:raw', $disk or die "open $disk: $!";
  local $/;
  my $disk_content = <$fh>;
  close $fh;
  my $h = sha256_hex($disk_content);
  if (!exists $contents{$rel}{$h}) {
    my @sets = sort keys %{ $contents{$rel} };
    print "::error::tree integrity: source DRIFTED from every Sourcify-verified revision ($#sets+1 sets): $rel\n";
    $fail = 1;
  }
}

# 2. Forge additions must match their pinned OZ v5.0.0 hashes.
for my $rel (sort keys %additions) {
  my $disk = "$tree_root/$rel";
  if (!-f $disk) {
    print "::error::tree integrity: forge addition MISSING: $rel\n";
    $fail = 1;
    next;
  }
  open my $fh, '<:raw', $disk or die "open $disk: $!";
  local $/;
  my $c = <$fh>;
  close $fh;
  my $h = sha256_hex($c);
  if ($h ne $additions{$rel}) {
    print "::error::tree integrity: forge addition DRIFTED from pinned OZ v5.0.0 hash: $rel\n";
    $fail = 1;
  }
  $embedded{$rel} = 1;
}

# 3. No uncovered .sol files in the tree (forge-std harness excluded).
my %seen;
my @queue = ($tree_root);
while (@queue) {
  my $p = pop @queue;
  if (-d $p) {
    opendir my $dh, $p or next;
    while (my $e = readdir $dh) {
      next if $e =~ /^\./;
      push @queue, "$p/$e";
    }
    closedir $dh;
  } elsif ($p =~ /\.sol$/) {
    (my $rel = $p) =~ s/^\Q$tree_root\E\///;
    next if $seen{$rel}++;
    next if $embedded{$rel};
    next if $rel =~ m{^lib/forge-std/};
    print "::error::tree integrity: .sol file NOT in any Sourcify-verified compile set or allowlist: $rel\n";
    $fail = 1;
  }
}

print $fail
  ? "TREE_INTEGRITY: FAILED\n"
  : "TREE_INTEGRITY_OK (", scalar(keys %embedded), " sources verified across ",
    scalar(@std_jsons), " compile sets + ", scalar(keys %additions), " allowlisted additions)\n";
exit $fail;
