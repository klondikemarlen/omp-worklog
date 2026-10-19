# frozen_string_literal: true

require "date"
require "digest"
require "json"
require "minitest/autorun"
require "stringio"
require "tmpdir"

$LOAD_PATH.unshift File.expand_path("lib", __dir__)
require "omp_worklog"

class BatchCLITest < Minitest::Test
  ACCOUNT_ENVIRONMENT = { "HARVEST_ACCOUNT_ID" => "test-account" }.freeze

  def test_concurrent_projects_keep_independent_durations_and_persist_receipts
    Dir.mktmpdir("batch-cli-") do |state_dir|
      entries = [
        review_entry("Project Alpha", "Alpha", "Development", 7_200_000),
        review_entry("Project Beta", "Beta", "Planning", 5_400_000)
      ]
      client = FakeHarvestClient.new(assignments: [
        assignment(101, "Alpha", 201, "Development"),
        assignment(102, "Beta", 202, "Planning")
      ])

      status, result, error = run_batch(client, review_batch(entries), state_dir:)

      assert_equal 0, status
      assert_equal "complete", result.fetch("status")
      assert_equal "", error
      assert_equal [2.0, 1.5], client.time_entries.map { |entry| entry.fetch("hours") }
      assert_equal [101, 102], client.time_entries.map { |entry| entry.fetch("project_id") }
      assert_equal [201, 202], client.time_entries.map { |entry| entry.fetch("task_id") }
      assert_equal [41, 41], client.time_entries.map { |entry| entry.fetch("user_id") }
      assert_equal entries.map { |entry| entry.fetch("id") }, client.time_entries.map { |entry| entry.dig("external_reference", "id") }

      receipt_path = Dir.glob(File.join(state_dir, "*.json")).fetch(0)
      receipt_document = JSON.parse(File.read(receipt_path))
      assert_equal %w[submitted submitted], receipt_document.fetch("entries").values.map { |receipt| receipt.fetch("status") }.sort
      assert_equal 0o600, File.stat(receipt_path).mode & 0o777
      assert_equal 0o700, File.stat(state_dir).mode & 0o777
    end
  end

  def test_whole_batch_preflight_failure_creates_nothing
    Dir.mktmpdir("batch-cli-") do |state_dir|
      entries = [
        review_entry("Mapped", "Internal", "Development", 3_600_000),
        review_entry("Unmapped", "Missing Project", "Development", 1_800_000)
      ]
      client = FakeHarvestClient.new

      status, result, = run_batch(client, review_batch(entries), state_dir:)

      assert_equal 1, status
      assert_equal "blocked", result.fetch("status")
      assert_equal ["not_submitted", "blocked"], result.fetch("results").map { |item| item.fetch("status") }
      assert_equal "destination_unmapped", result.fetch("results").last.fetch("reason")
      assert_empty client.time_entries
      assert_equal 0, client.post_attempts
      assert_empty Dir.glob(File.join(state_dir, "*.json"))
    end
  end

  def test_exact_rerun_is_already_filed_without_a_second_create
    Dir.mktmpdir("batch-cli-") do |state_dir|
      entry = review_entry("Internal", "Internal", "Development", 3_600_000)
      batch = review_batch([entry])
      client = FakeHarvestClient.new

      first_status, first_result, = run_batch(client, batch, state_dir:)
      second_status, second_result, = run_batch(client, batch, state_dir:)

      assert_equal 0, first_status
      assert_equal "created", first_result.fetch("results").first.fetch("status")
      assert_equal 0, second_status
      assert_equal "already_filed", second_result.fetch("results").first.fetch("status")
      assert_equal 1, client.post_attempts
      assert_equal 1, client.time_entries.length
    end
  end

  def test_changed_content_for_an_existing_identity_is_a_conflict
    Dir.mktmpdir("batch-cli-") do |state_dir|
      entry = review_entry("Internal", "Internal", "Development", 3_600_000)
      client = FakeHarvestClient.new
      first_status, = run_batch(client, review_batch([entry]), state_dir:)
      changed_entry = entry.merge("milliseconds" => 1_800_000)

      changed_status, changed_result, = run_batch(client, review_batch([changed_entry]), state_dir:)

      assert_equal 0, first_status
      assert_equal 1, changed_status
      assert_equal "conflict", changed_result.fetch("results").first.fetch("status")
      assert_equal "external_reference_content_conflict", changed_result.fetch("results").first.fetch("reason")
      assert_equal [1.0], client.time_entries.map { |remote_entry| remote_entry.fetch("hours") }
      assert_equal 1, client.post_attempts
    end
  end

  def test_existing_destination_on_a_later_time_entry_page_blocks_the_batch
    Dir.mktmpdir("batch-cli-") do |state_dir|
      entry = review_entry("Internal", "Internal", "Development", 3_600_000)
      client = FakeHarvestClient.new(time_entry_page_size: 1)
      client.seed_time_entry(
        user_id: 41,
        project_id: 901,
        task_id: 902,
        spent_date: entry.fetch("spentDate"),
        hours: 0.5,
        notes: "Other destination"
      )
      client.seed_time_entry(
        user_id: 41,
        project_id: 101,
        task_id: 201,
        spent_date: entry.fetch("spentDate"),
        hours: 0.5,
        notes: "Existing manual entry",
        locked: true,
        running: true
      )

      status, result, = run_batch(client, review_batch([entry]), state_dir:)

      assert_equal 1, status
      assert_equal "blocked", result.fetch("results").first.fetch("status")
      assert_equal "locked_or_running_entry", result.fetch("results").first.fetch("reason")
      assert_empty client.created_entries
      assert_equal 0, client.post_attempts
      assert client.requests.any? { |request| request[:path] == "/v2/time_entries" && request[:params][:page] == 2 && !request[:params].key?(:external_reference_id) }
    end
  end

  def test_unrelated_entry_for_another_user_does_not_block_current_user
    Dir.mktmpdir("batch-cli-") do |state_dir|
      entry = review_entry("Internal", "Internal", "Development", 3_600_000)
      client = FakeHarvestClient.new
      client.seed_time_entry(
        user_id: 98,
        project_id: 101,
        task_id: 201,
        spent_date: entry.fetch("spentDate"),
        hours: 0.5,
        notes: "Another user's entry"
      )

      status, result, = run_batch(client, review_batch([entry]), state_dir:)

      assert_equal 0, status
      assert_equal "created", result.fetch("results").first.fetch("status")
      assert_equal 2, client.time_entries.length
      assert_equal [98, 41], client.time_entries.map { |remote_entry| remote_entry.fetch("user_id") }
      assert client.requests.any? { |request| request[:path] == "/v2/time_entries" && request[:params][:user_id] == 41 }
    end
  end

  def test_destination_can_be_resolved_from_a_later_assignment_page
    Dir.mktmpdir("batch-cli-") do |state_dir|
      entry = review_entry("Later Project", "Later Project", "Development", 3_600_000)
      assignments = [
        assignment(101, "Other Project", 201, "Planning"),
        assignment(102, "Later Project", 202, "Development")
      ]
      client = FakeHarvestClient.new(assignments:, assignment_page_size: 1)

      status, result, = run_batch(client, review_batch([entry]), state_dir:)

      assert_equal 0, status
      assert_equal 102, client.created_entries.first.fetch("project_id")
      assert_equal 202, client.created_entries.first.fetch("task_id")
      assert client.requests.any? { |request| request[:path] == "/v2/users/me/project_assignments" && request[:params][:page] == 2 }
    end
  end

  def test_unmapped_destination_is_reported_without_a_create
    Dir.mktmpdir("batch-cli-") do |state_dir|
      entry = review_entry("Missing", "Missing Project", "Development", 3_600_000)
      client = FakeHarvestClient.new

      status, result, = run_batch(client, review_batch([entry]), state_dir:)

      assert_equal 1, status
      assert_equal "destination_unmapped", result.fetch("results").first.fetch("reason")
      assert_empty client.created_entries
      assert_equal 0, client.post_attempts
    end
  end

  def test_unapproved_batch_is_rejected_before_provider_access
    Dir.mktmpdir("batch-cli-") do |state_dir|
      entry = review_entry("Internal", "Internal", "Development", 3_600_000)
      client = FakeHarvestClient.new

      status, result, error = run_batch(
        client,
        review_batch([entry], approved: false),
        state_dir:,
        environment: ForbiddenEnvironment.new
      )

      assert_equal 1, status
      assert_equal "blocked", result.fetch("status")
      assert_includes error, "batch_not_approved"
      assert_empty client.requests
    end
  end

  def test_blank_reviewed_notes_are_rejected_before_provider_access
    Dir.mktmpdir("batch-cli-") do |state_dir|
      entry = review_entry("Internal", "Internal", "Development", 3_600_000).merge("notes" => " \n")
      client = FakeHarvestClient.new

      status, result, error = run_batch(client, review_batch([entry]), state_dir:)

      assert_equal 1, status
      assert_equal "blocked", result.fetch("status")
      assert_includes error, "reviewed_notes_required"
      assert_empty client.requests
    end
  end

  def test_impossible_spent_date_is_rejected_before_provider_access
    Dir.mktmpdir("batch-cli-") do |state_dir|
      entry = review_entry("Internal", "Internal", "Development", 3_600_000).merge("spentDate" => "2026-02-30")
      client = FakeHarvestClient.new

      batch = review_batch([entry])
      batch["from"] = "2026-10-19"
      batch["to"] = "2026-10-19"
      status, result, error = run_batch(client, batch, state_dir:)

      assert_equal 1, status
      assert_equal "blocked", result.fetch("status")
      assert_includes error, "invalid_entry_date"
      assert_empty client.requests
    end
  end

  def test_duration_above_candidate_is_rejected_before_provider_access
    Dir.mktmpdir("batch-cli-") do |state_dir|
      entry = review_entry("Internal", "Internal", "Development", 3_600_000).merge("milliseconds" => 3_600_001)
      client = FakeHarvestClient.new

      status, result, error = run_batch(client, review_batch([entry]), state_dir:)

      assert_equal 1, status
      assert_equal "blocked", result.fetch("status")
      assert_includes error, "duration_exceeds_candidate"
      assert_empty client.requests
    end
  end

  def test_missing_destination_names_are_rejected_before_provider_access
    Dir.mktmpdir("batch-cli-") do |state_dir|
      entry = review_entry("Internal", "Internal", "Development", 3_600_000).merge("task" => " ")
      client = FakeHarvestClient.new

      status, result, error = run_batch(client, review_batch([entry]), state_dir:)

      assert_equal 1, status
      assert_equal "blocked", result.fetch("status")
      assert_includes error, "destination_required"
      assert_empty client.requests
    end
  end

  def test_duplicate_resolved_destinations_block_every_entry_before_remote_reads
    Dir.mktmpdir("batch-cli-") do |state_dir|
      entries = [
        review_entry("Local Alpha", "Internal", "Development", 3_600_000),
        review_entry("Local Beta", "Internal", "Development", 1_800_000)
      ]
      client = FakeHarvestClient.new

      status, result, = run_batch(client, review_batch(entries), state_dir:)

      assert_equal 1, status
      assert_equal ["conflict", "conflict"], result.fetch("results").map { |item| item.fetch("status") }
      assert result.fetch("results").all? { |item| item.fetch("reason") == "duplicate_destination" }
      assert_empty client.created_entries
      assert_equal 0, client.requests.count { |request| request[:method] == :post }
      assert_equal 0, client.requests.count { |request| request[:path] == "/v2/time_entries" }
    end
  end

  def test_timestamp_timer_accounts_are_rejected_before_writes
    Dir.mktmpdir("batch-cli-") do |state_dir|
      entry = review_entry("Internal", "Internal", "Development", 3_600_000)
      client = FakeHarvestClient.new(timestamp_timer_mode: true)

      status, result, = run_batch(client, review_batch([entry]), state_dir:)

      assert_equal 1, status
      assert_empty client.created_entries
      assert_equal "/v2/company", client.requests.last.fetch(:path)
      assert_equal "blocked", result.fetch("status")
    end
  end

  def test_uncertain_create_keeps_partial_remote_state_and_stops_remaining_entries
    Dir.mktmpdir("batch-cli-") do |state_dir|
      entries = [
        review_entry("Alpha", "Alpha", "Development", 3_600_000),
        review_entry("Beta", "Beta", "Development", 1_800_000),
        review_entry("Gamma", "Gamma", "Development", 900_000)
      ]
      assignments = [
        assignment(101, "Alpha", 201, "Development"),
        assignment(102, "Beta", 202, "Development"),
        assignment(103, "Gamma", 203, "Development")
      ]
      client = FakeHarvestClient.new(assignments:)
      client.fail_post_on(2, after_create: true)

      status, result, = run_batch(client, review_batch(entries), state_dir:)

      assert_equal 1, status
      assert_equal "uncertain", result.fetch("status")
      assert_equal ["created", "uncertain", "not_submitted"], result.fetch("results").map { |item| item.fetch("status") }
      assert_equal 2, client.post_attempts
      assert_equal 2, client.created_entries.length
      receipts = receipt_document(state_dir).fetch("entries")
      assert_equal "submitted", receipts.fetch(entries[0].fetch("id")).fetch("status")
      assert_equal "uncertain", receipts.fetch(entries[1].fetch("id")).fetch("status")
      refute receipts.key?(entries[2].fetch("id"))
    end
  end

  def test_definite_create_rejection_reports_partial_without_rollback
    Dir.mktmpdir("batch-cli-") do |state_dir|
      entries = [
        review_entry("Alpha", "Alpha", "Development", 3_600_000),
        review_entry("Beta", "Beta", "Development", 1_800_000),
        review_entry("Gamma", "Gamma", "Development", 900_000)
      ]
      assignments = [
        assignment(101, "Alpha", 201, "Development"),
        assignment(102, "Beta", 202, "Development"),
        assignment(103, "Gamma", 203, "Development")
      ]
      client = FakeHarvestClient.new(assignments:)
      client.reject_post_on(2)

      status, result, error = run_batch(client, review_batch(entries), state_dir:)

      assert_equal 1, status
      assert_equal "partial", result.fetch("status")
      assert_equal ["created", "blocked", "not_submitted"], result.fetch("results").map { |item| item.fetch("status") }
      assert_equal 2, client.post_attempts
      assert_equal 1, client.created_entries.length
      refute_includes JSON.generate(result), "provider secret"
      receipts = receipt_document(state_dir).fetch("entries")
      assert_equal "submitted", receipts.fetch(entries[0].fetch("id")).fetch("status")
      assert_equal "rejected", receipts.fetch(entries[1].fetch("id")).fetch("status")
      refute receipts.key?(entries[2].fetch("id"))
    end
  end

  def test_provider_request_timeout_remains_uncertain_and_is_not_retried
    Dir.mktmpdir("batch-cli-") do |state_dir|
      entry = review_entry("Internal", "Internal", "Development", 3_600_000)
      batch = review_batch([entry])
      client = FakeHarvestClient.new
      client.reject_post_on(1, status: "408")

      first_status, first_result, = run_batch(client, batch, state_dir:)
      second_status, second_result, = run_batch(client, batch, state_dir:)

      assert_equal 1, first_status
      assert_equal "uncertain", first_result.fetch("status")
      assert_equal 1, second_status
      assert_equal "remote_entry_not_found", second_result.fetch("results").first.fetch("reason")
      assert_equal 1, client.post_attempts
    end
  end

  def test_uncertain_create_without_remote_match_is_not_retried
    Dir.mktmpdir("batch-cli-") do |state_dir|
      entry = review_entry("Internal", "Internal", "Development", 3_600_000)
      batch = review_batch([entry])
      client = FakeHarvestClient.new
      client.fail_post_on(1, after_create: false)

      first_status, first_result, = run_batch(client, batch, state_dir:)
      client.clear_post_failure
      second_status, second_result, = run_batch(client, batch, state_dir:)

      assert_equal 1, first_status
      assert_equal "uncertain", first_result.fetch("status")
      assert_equal 1, second_status
      assert_equal "uncertain", second_result.fetch("status")
      assert_equal "remote_entry_not_found", second_result.fetch("results").first.fetch("reason")
      assert_equal 1, client.post_attempts
      assert_empty client.created_entries
      assert_equal "uncertain", receipt_document(state_dir).dig("entries", entry.fetch("id"), "status")
    end
  end

  def test_exact_remote_reconciliation_resolves_an_uncertain_receipt
    Dir.mktmpdir("batch-cli-") do |state_dir|
      entry = review_entry("Internal", "Internal", "Development", 3_600_000)
      batch = review_batch([entry])
      client = FakeHarvestClient.new
      client.fail_post_on(1, after_create: true)

      first_status, first_result, = run_batch(client, batch, state_dir:)
      client.clear_post_failure
      second_status, second_result, = run_batch(client, batch, state_dir:)

      assert_equal 1, first_status
      assert_equal "uncertain", first_result.fetch("status")
      assert_equal 0, second_status
      assert_equal "already_filed", second_result.fetch("results").first.fetch("status")
      assert_equal "complete", second_result.fetch("status")
      assert_equal 1, client.post_attempts
      assert_equal 1, client.created_entries.length
      receipt = receipt_document(state_dir).dig("entries", entry.fetch("id"))
      assert_equal "submitted", receipt.fetch("status")
      assert_equal client.created_entries.first.fetch("id"), receipt.fetch("harvestEntryId")
    end
  end

  def test_dry_run_preserves_and_reports_an_uncertain_submission
    Dir.mktmpdir("batch-cli-") do |state_dir|
      entry = review_entry("Internal", "Internal", "Development", 3_600_000)
      batch = review_batch([entry])
      client = FakeHarvestClient.new
      client.fail_post_on(1, after_create: false)
      run_batch(client, batch, state_dir:)
      original_receipts = receipt_document(state_dir)
      client.clear_post_failure

      status, result, = run_batch(client, batch, state_dir:, dry_run: true)

      assert_equal 1, status
      assert_equal "uncertain", result.fetch("status")
      assert_equal "remote_entry_not_found", result.fetch("results").first.fetch("reason")
      assert_equal original_receipts, receipt_document(state_dir)
      assert_equal 1, client.post_attempts
    end
  end

  def test_dry_run_preflights_unapproved_reviewed_entries_without_receipts
    Dir.mktmpdir("batch-cli-") do |state_dir|
      entry = review_entry("Internal", "Internal", "Development", 3_600_000)
      client = FakeHarvestClient.new

      status, result, error = run_batch(client, review_batch([entry], approved: false), state_dir:, dry_run: true)

      assert_equal 0, status
      assert_equal "preflight", result.fetch("mode")
      assert_equal "ready", result.fetch("status")
      assert_equal "", error
      assert_empty client.created_entries
      assert_empty Dir.children(state_dir)
    end
  end

  private

  def run_batch(client, batch, state_dir:, dry_run: false, environment: ACCOUNT_ENVIRONMENT)
    arguments = ["--state-dir", state_dir]
    arguments.unshift("--dry-run") if dry_run
    input = StringIO.new(JSON.generate(batch))
    output = StringIO.new
    error = StringIO.new

    status = OmpWorklog::BatchCLI.run(
      arguments,
      input:,
      output:,
      error:,
      client:,
      environment:
    )

    [status, JSON.parse(output.string), error.string]
  end

  def review_batch(entries, approved: true)
    dates = entries.map { |entry| entry.fetch("spentDate") }.sort
    {
      "format" => "omp-worklog/review-batch",
      "version" => 1,
      "approved" => approved,
      "from" => dates.first,
      "to" => dates.last,
      "policy" => { "mode" => "concurrent-projects", "responseGraceMinutes" => 5 },
      "entries" => entries
    }
  end

  def review_entry(local_project, project, task, milliseconds, spent_date: "2026-10-19", notes: "Reviewed ordinary work")
    digest = Digest::SHA256.hexdigest(JSON.generate(["omp-worklog/v1", spent_date, local_project]))
    {
      "id" => "omp-worklog-v1:#{digest}",
      "spentDate" => spent_date,
      "localProject" => local_project,
      "project" => project,
      "task" => task,
      "candidateMilliseconds" => milliseconds,
      "milliseconds" => milliseconds,
      "humanActiveMilliseconds" => milliseconds,
      "agentTurnMilliseconds" => 0,
      "bridgedGapMilliseconds" => 0,
      "sourceEntryIds" => ["source-#{local_project}"],
      "notes" => notes,
      "reviewed" => true,
      "reviewReasons" => ["progress_and_user_blockers_require_review"]
    }
  end

  def assignment(project_id, project_name, task_id, task_name)
    {
      "is_active" => true,
      "project" => { "id" => project_id, "name" => project_name, "is_active" => true },
      "task_assignments" => [
        { "is_active" => true, "task" => { "id" => task_id, "name" => task_name } }
      ]
    }
  end

  def receipt_document(state_dir)
    path = Dir.glob(File.join(state_dir, "*.json")).fetch(0)
    JSON.parse(File.read(path))
  end

  class ForbiddenEnvironment
    def [](key)
      raise "Unexpected environment access for #{key}"
    end
  end

  class FakeHarvestClient
    attr_reader :requests, :time_entries, :post_attempts, :created_entries

    def initialize(
      assignments: nil,
      user_id: 41,
      timestamp_timer_mode: false,
      assignment_page_size: nil,
      time_entry_page_size: nil
    )
      @assignments = assignments || [
        {
          "is_active" => true,
          "project" => { "id" => 101, "name" => "Internal", "is_active" => true },
          "task_assignments" => [
            { "is_active" => true, "task" => { "id" => 201, "name" => "Development" } }
          ]
        }
      ]
      @user_id = user_id
      @timestamp_timer_mode = timestamp_timer_mode
      @assignment_page_size = assignment_page_size
      @time_entry_page_size = time_entry_page_size
      @time_entries = []
      @created_entries = []
      @requests = []
      @next_entry_id = 1
      @post_attempts = 0
      @failure_attempt = nil
      @failure_after_create = false
      @rejection_attempt = nil
    end

    def request(method, path, params: {}, body: nil)
      @requests << { method:, path:, params: params.dup, body: body&.dup }

      if method == :get
        return { "id" => @user_id } if path == "/v2/users/me"
        return { "wants_timestamp_timers" => @timestamp_timer_mode } if path == "/v2/company"
        return page_response("project_assignments", @assignments, params, @assignment_page_size) if path == "/v2/users/me/project_assignments"
        return time_entry_page(params) if path == "/v2/time_entries"
      end

      if method == :post && path == "/v2/time_entries"
        create_time_entry(body)
      else
        raise "Unexpected request"
      end
    end

    def seed_time_entry(user_id:, project_id:, task_id:, spent_date:, hours:, notes:, external_reference: nil, locked: false, running: false)
      @time_entries << {
        "id" => @next_entry_id,
        "user_id" => user_id,
        "project_id" => project_id,
        "task_id" => task_id,
        "spent_date" => spent_date,
        "hours" => hours,
        "notes" => notes,
        "external_reference" => external_reference,
        "is_locked" => locked,
        "is_running" => running
      }
      @next_entry_id += 1
    end

    def fail_post_on(attempt, after_create:)
      @failure_attempt = attempt
      @failure_after_create = after_create
    end

    def clear_post_failure
      @failure_attempt = nil
    end

    def reject_post_on(attempt, status: "422")
      @rejection_attempt = attempt
      @rejection_status = status
    end

    private

    def create_time_entry(body)
      @post_attempts += 1
      if @rejection_attempt == @post_attempts
        raise Marlens::HarvestApiV2::Error.new(@rejection_status, "provider secret response body")
      end
      if @failure_attempt == @post_attempts && !@failure_after_create
        raise IOError, "simulated connection failure before remote creation"
      end

      normalized_body = body.transform_keys(&:to_s)
      normalized_body["external_reference"] = { "id" => body.dig(:external_reference, :id) }
      entry = normalized_body.merge(
        "id" => @next_entry_id,
        "is_locked" => false,
        "is_running" => false
      )
      @time_entries << entry
      @created_entries << entry
      @next_entry_id += 1
      raise IOError, "simulated connection failure after remote creation" if @failure_attempt == @post_attempts

      { "id" => entry.fetch("id") }
    end

    def time_entry_page(params)
      records = @time_entries.select { |entry| entry["user_id"] == params.fetch(:user_id) }
      records = records.select { |entry| entry["spent_date"] >= params.fetch(:from) } if params.key?(:from)
      records = records.select { |entry| entry["spent_date"] <= params.fetch(:to) } if params.key?(:to)
      if params.key?(:external_reference_id)
        records = records.select do |entry|
          entry.dig("external_reference", "id") == params.fetch(:external_reference_id)
        end
      end
      records = records.map do |entry|
        entry.reject { |key, _| %w[user_id project_id task_id].include?(key) }.merge(
          "user" => { "id" => entry.fetch("user_id") },
          "project" => { "id" => entry.fetch("project_id") },
          "task" => { "id" => entry.fetch("task_id") }
        )
      end

      page_response("time_entries", records, params, @time_entry_page_size)
    end

    def page_response(collection, records, params, requested_page_size)
      page = params.fetch(:page, 1)
      page_size = requested_page_size || params.fetch(:per_page)
      page_records = records.slice((page - 1) * page_size, page_size) || []
      next_page = (page + 1) if page * page_size < records.length
      { collection => page_records, "next_page" => next_page }
    end
  end
end
