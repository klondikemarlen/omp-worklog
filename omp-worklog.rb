#!/usr/bin/env ruby
# frozen_string_literal: true

$LOAD_PATH.unshift File.expand_path("lib", __dir__)
require "omp_worklog"

exit OmpWorklog::CLI.run(ARGV)
