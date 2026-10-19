# frozen_string_literal: true

require_relative "lib/omp_worklog/version"

Gem::Specification.new do |spec|
  spec.name = "omp-worklog"
  spec.version = OmpWorklog::VERSION
  spec.authors = ["Marlen Brunner"]
  spec.email = ["klondikemarlen@gmail.com"]
  spec.summary = "Concurrent-project work logs with reviewed, safe Harvest batch filing."
  spec.homepage = "https://github.com/klondikemarlen/omp-worklog"
  spec.license = "MIT"
  spec.required_ruby_version = ">= 3.2"

  spec.metadata["source_code_uri"] = spec.homepage

  spec.files = Dir["lib/**/*.rb", "bin/*", "omp-worklog.rb", "README.md"]
  spec.bindir = "bin"
  spec.executables = ["omp-worklog"]
  spec.require_paths = ["lib"]

  spec.add_dependency "marlens-harvest-api-v2", "~> 0.2"
  spec.add_dependency "business_time", "~> 0.13"
  spec.add_dependency "holidays", "~> 9.2"
end
