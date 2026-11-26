# frozen_string_literal: true

require "date"
require "tmpdir"
require "minitest/autorun"
require "json"
require "stringio"

$LOAD_PATH.unshift File.expand_path("lib", __dir__)
require "omp_worklog"

class OmpWorklogTest < Minitest::Test
  def test_global_help_lists_name_and_id_assignment_forms
    output = StringIO.new

    assert_equal 0, OmpWorklog::CLI.run(["--help"], output:)
    assert_includes output.string, "time-off FROM TO --project-id ID --task-id ID"
    assert_includes output.string, "work-entry DATE --project-id ID --task-id ID"
    refute_includes output.string, "timesheet"
    refute_includes output.string, "aggregate"
    refute_includes output.string, "reconcile"
  end

  def test_global_version_prints_the_installed_release_version
    output = StringIO.new
    error = StringIO.new

    assert_equal 0, OmpWorklog::CLI.run(["--version"], output:, error:)
    assert_equal "#{OmpWorklog::VERSION}\n", output.string
    assert_equal "", error.string
  end

  def test_dates_between_skips_weekends_by_default
    from = Date.new(2026, 7, 17)
    to = Date.new(2026, 7, 20)

    assert_equal [Date.new(2026, 7, 17), Date.new(2026, 7, 20)], OmpWorklog.dates_between(from, to, holiday_regions: ["ca"])
  end

  def test_dates_between_excludes_observed_regional_holidays
    dates = OmpWorklog.dates_between(Date.new(2007, 7, 2), Date.new(2007, 7, 6), holiday_regions: ["ca_bc"])

    assert_equal [Date.new(2007, 7, 3), Date.new(2007, 7, 4), Date.new(2007, 7, 5), Date.new(2007, 7, 6)], dates
  end

  def test_time_off_rejects_blank_names_and_nonpositive_ids
    empty_name_error = StringIO.new
    blank_notes_error = StringIO.new
    invalid_id_error = StringIO.new

    assert_equal 1, OmpWorklog::TimeOffCLI.run(
      ["2026-07-17", "2026-07-17", "--project", " ", "--task", "Vacation", "--dry-run"],
      error: empty_name_error
    )
    assert_includes empty_name_error.string, "supply --project and --task"
    assert_equal 1, OmpWorklog::TimeOffCLI.run(
      ["2026-07-17", "2026-07-17", "--project", "PTO", "--task", "Vacation", "--notes", " ", "--dry-run"],
      error: blank_notes_error
    )
    assert_includes blank_notes_error.string, "--notes must not be blank"
    assert_equal 1, OmpWorklog::TimeOffCLI.run(
      ["2026-07-17", "2026-07-17", "--project-id", "0", "--task-id", "-1", "--dry-run"],
      error: invalid_id_error
    )
    assert_includes invalid_id_error.string, "supply --project and --task"
  end

  def test_work_entry_rejects_blank_names_notes_and_nonpositive_ids
    empty_name_error = StringIO.new
    blank_notes_error = StringIO.new
    invalid_id_error = StringIO.new

    assert_equal 1, OmpWorklog::WorkEntryCLI.run(
      ["2026-07-17", "--project", " ", "--task", "Programming", "--hours", "1", "--notes", "Work", "--dry-run"],
      error: empty_name_error
    )
    assert_includes empty_name_error.string, "supply --project and --task"
    assert_equal 1, OmpWorklog::WorkEntryCLI.run(
      ["2026-07-17", "--project", "WRAP", "--task", "Programming", "--hours", "1", "--notes", " ", "--dry-run"],
      error: blank_notes_error
    )
    assert_includes blank_notes_error.string, "--notes is required"
    assert_equal 1, OmpWorklog::WorkEntryCLI.run(
      ["2026-07-17", "--project-id", "0", "--task-id", "-1", "--hours", "1", "--notes", "Work", "--dry-run"],
      error: invalid_id_error
    )
    assert_includes invalid_id_error.string, "supply --project and --task"
  end


  def test_dry_run_accepts_hours_notes_and_named_assignment
    output = StringIO.new
    error = StringIO.new

    status = OmpWorklog::CLI.run(
      ["time-off", "2026-07-17", "2026-07-20", "--project", "Time Off - Marlen", "--task", "Vacation / PTO", "--notes", "Vacation", "--holiday-region", "ca", "--dry-run"],
      output:,
      error:
    )

    assert_equal 0, status
    assert_equal "", error.string
    assert_equal 2, output.string.lines.length
    assert_includes output.string, "2026-07-17: 7h on Time Off - Marlen / Vacation / PTO; Vacation"
    assert_includes output.string, "2026-07-20: 7h on Time Off - Marlen / Vacation / PTO; Vacation"
  end

  def test_time_off_normalizes_regions_and_rejects_whitespace_only_values
    options = { holiday_regions: ["ca_yt"] }
    OmpWorklog::TimeOffCLI.option_parser(options).parse(["--holiday-region", "CA_YT", "--holiday-region", " "])
    assert_equal ["ca_yt"], OmpWorklog::TimeOffCLI.normalize_holiday_regions!(options[:holiday_regions])

    empty_options = { holiday_regions: [], hours: 7.0, project: "PTO", task: "Vacation" }
    OmpWorklog::TimeOffCLI.option_parser(empty_options).parse(["--holiday-region", " "])
    OmpWorklog::TimeOffCLI.normalize_holiday_regions!(empty_options[:holiday_regions])
    error = assert_raises(OmpWorklog::Error) { OmpWorklog::TimeOffCLI.validate!(["2026-07-17", "2026-07-17"], empty_options) }
    assert_equal "--holiday-region or HARVEST_HOLIDAY_REGIONS is required", error.message
  end

  def test_cli_defaults_to_yukon_holidays
    output = StringIO.new

    status = OmpWorklog::TimeOffCLI.run(
      ["2026-08-17", "2026-08-28", "--project", "Time Off - Marlen", "--task", "Vacation / PTO", "--dry-run"],
      output:
    )

    assert_equal 0, status
    assert_equal 9, output.string.lines.length
    refute_includes output.string, "2026-08-17"
  end


  def test_command_resolves_assignment_and_creates_one_entry_per_workday
    client = FakeClient.new
    output = StringIO.new
    error = StringIO.new

    status = OmpWorklog::TimeOffCLI.run(
      ["2026-07-17", "2026-07-20", "--project", "Time Off - Marlen", "--task", "Vacation / PTO", "--hours", "7.5", "--notes", "Vacation", "--holiday-region", "ca"],
      output:,
      error:,
      client:
    )

    assert_equal 0, status
    assert_equal "", error.string
    assert_equal 2, client.entries.length
    assert_equal :personal, client.assignment_source
    assert_equal(
      [
        { project_id: 48_730_683, task_id: 8_083_365, spent_date: Date.new(2026, 7, 17), hours: 7.5, notes: "Vacation" },
        { project_id: 48_730_683, task_id: 8_083_365, spent_date: Date.new(2026, 7, 20), hours: 7.5, notes: "Vacation" }
      ],
      client.entries
    )
    assert_includes output.string, "Created 2026-07-17: 7.5h (entry #1)"
  end

  def test_work_entry_preview_checks_existing_entries_before_proposing_write
    client = FakeClient.new
    output = StringIO.new
    error = StringIO.new

    status = OmpWorklog::CLI.run(
      ["work-entry", "2026-07-17", "--project", "Time Off - Marlen", "--task", "Vacation / PTO", "--hours", "2.25", "--notes", "OMP Project Time: Harvest API", "--dry-run"],
      output:,
      error:,
      client:
    )

    assert_equal 0, status
    assert_equal "", error.string
    assert_includes output.string, "Would create 2026-07-17: 2.25h"
    assert_equal [{ method: :get, path: "/v2/time_entries", params: { project_id: 48_730_683, task_id: 8_083_365, from: "2026-07-17", to: "2026-07-17" } }], client.requests
  end

  def test_work_entry_id_preview_names_the_assignment
    client = FakeClient.new
    output = StringIO.new

    status = OmpWorklog::CLI.run(
      ["work-entry", "2026-07-17", "--project-id", "123", "--task-id", "456", "--hours", "2.25", "--notes", "Reviewed work", "--dry-run"],
      output:,
      client:
    )

    assert_equal 0, status
    assert_includes output.string, "Would create 2026-07-17: 2.25h on project #123 / task #456; Reviewed work"
    assert_equal [{ method: :get, path: "/v2/time_entries", params: { project_id: 123, task_id: 456, from: "2026-07-17", to: "2026-07-17" } }], client.requests
  end

  def test_work_entry_skips_locked_existing_entry
    client = FakeClient.new(existing_entries: [{ "is_locked" => true }])
    output = StringIO.new

    status = OmpWorklog::WorkEntryCLI.run(
      ["2026-07-17", "--project", "Time Off - Marlen", "--task", "Vacation / PTO", "--hours", "2.25", "--notes", "OMP Project Time: Harvest API"],
      output:,
      client:
    )

    assert_equal OmpWorklog::WorkEntryCLI::LOCKED_ENTRY, status
    assert_equal "Locked existing Harvest entry on 2026-07-17; skipped\n", output.string
    assert_empty client.entries
  end

  def test_work_entry_skips_existing_unlocked_entry
    client = FakeClient.new(existing_entries: [{ "is_locked" => false }])
    output = StringIO.new

    status = OmpWorklog::WorkEntryCLI.run(
      ["2026-07-17", "--project", "Time Off - Marlen", "--task", "Vacation / PTO", "--hours", "2.25", "--notes", "OMP Project Time: Harvest API"],
      output:,
      client:
    )

    assert_equal OmpWorklog::WorkEntryCLI::EXISTING_ENTRY, status
    assert_equal "Existing Harvest entry on 2026-07-17; skipped\n", output.string
    assert_empty client.entries
  end

  def test_work_entry_activity_entry_allows_distinct_activity
    client = FakeClient.new(existing_entries: [{ "is_locked" => false, "notes" => "OMP Project Time activity: \"implementation\"\nHarvest API (repo)" }])

    status = OmpWorklog::WorkEntryCLI.run(
      ["2026-07-17", "--project", "Time Off - Marlen", "--task", "Vacation / PTO", "--hours", "2.25", "--notes", "OMP Project Time activity: \"review\"\nHarvest API (repo)", "--activity-entry"],
      client:
    )

    assert_equal 0, status
    assert_equal 1, client.entries.length
  end

  def test_work_entry_activity_entry_skips_the_same_activity
    client = FakeClient.new(existing_entries: [{ "is_locked" => false, "notes" => "OMP Project Time activity: \"implementation\"\nHarvest API (repo)" }])

    status = OmpWorklog::WorkEntryCLI.run(
      ["2026-07-17", "--project", "Time Off - Marlen", "--task", "Vacation / PTO", "--hours", "2.25", "--notes", "OMP Project Time activity: \"implementation\"\nDifferent repository", "--activity-entry"],
      client:
    )

    assert_equal OmpWorklog::WorkEntryCLI::EXISTING_ENTRY, status
    assert_empty client.entries
  end

  def test_work_entry_activity_entry_skips_an_unrelated_entry
    client = FakeClient.new(existing_entries: [{ "is_locked" => false, "notes" => "Manual work" }])

    status = OmpWorklog::WorkEntryCLI.run(
      ["2026-07-17", "--project", "Time Off - Marlen", "--task", "Vacation / PTO", "--hours", "2.25", "--notes", "OMP Project Time activity: \"implementation\"\nHarvest API (repo)", "--activity-entry"],
      client:
    )

    assert_equal OmpWorklog::WorkEntryCLI::EXISTING_ENTRY, status
    assert_empty client.entries
  end

  def test_work_entry_activity_entry_keeps_distinct_activities_on_one_date
    client = FakeClient.new
    implementation = ["2026-07-17", "--project", "Time Off - Marlen", "--task", "Vacation / PTO", "--hours", "2.25", "--notes", "OMP Project Time activity: \"implementation\"\nHarvest API (repo)", "--activity-entry"]
    review = ["2026-07-17", "--project", "Time Off - Marlen", "--task", "Vacation / PTO", "--hours", "0.5", "--notes", "OMP Project Time activity: \"review\"\nHarvest API (repo)", "--activity-entry"]

    assert_equal 0, OmpWorklog::WorkEntryCLI.run(implementation, client:)
    assert_equal 0, OmpWorklog::WorkEntryCLI.run(review, client:)
    assert_equal OmpWorklog::WorkEntryCLI::EXISTING_ENTRY, OmpWorklog::WorkEntryCLI.run(implementation, client:)
    assert_equal(["OMP Project Time activity: \"implementation\"\nHarvest API (repo)", "OMP Project Time activity: \"review\"\nHarvest API (repo)"], client.entries.map { |entry| entry.fetch(:notes) })
  end












  class FakeClient
    attr_reader :assignment_source, :entries, :requests

    def initialize(existing_entries: [])
      @entries = []
      @existing_entries = existing_entries
      @requests = []
    end

    def active_personal_task_assignments
      @assignment_source = :personal
      [{ "project" => { "id" => 48_730_683, "name" => "Time Off - Marlen" }, "task" => { "id" => 8_083_365, "name" => "Vacation / PTO" } }]
    end

    def request(method, path, params:)
      @requests << { method:, path:, params: }
      { "time_entries" => @existing_entries + @entries.map { |entry| { "is_locked" => false, "notes" => entry.fetch(:notes) } } }
    end

    def create_time_entry(**entry)
      @entries << entry
      { "id" => @entries.length }
    end
  end


end
