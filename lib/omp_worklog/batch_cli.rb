# frozen_string_literal: true

require "digest"
require "fileutils"
require "json"
require "optparse"
require "tempfile"

module OmpWorklog
  class BatchCLI
    FORMAT = "omp-worklog/review-batch"
    RESULT_FORMAT = "omp-worklog/batch-result"
    ID_PREFIX = "omp-worklog-v1:"
    RECEIPT_FORMAT = "omp-worklog/submission-receipts"
    PER_PAGE = 200

    TOP_LEVEL_KEYS = %w[format version approved from to policy entries].freeze
    POLICY_KEYS = %w[mode responseGraceMinutes].freeze
    ENTRY_KEYS = %w[
      id spentDate localProject project task candidateMilliseconds milliseconds
      humanActiveMilliseconds agentTurnMilliseconds bridgedGapMilliseconds
      sourceEntryIds notes reviewed reviewReasons adjustmentReason
    ].freeze
    REQUIRED_ENTRY_KEYS = (ENTRY_KEYS - ["adjustmentReason"]).freeze
    MAX_SAFE_INTEGER = 9_007_199_254_740_991

    class InputError < StandardError
      attr_reader :code

      def initialize(code)
        @code = code
        super(code)
      end
    end

    class ProviderFailure < StandardError
      attr_reader :code

      def initialize(code)
        @code = code
        super(code)
      end
    end

    def self.run(arguments, input: $stdin, output: $stdout, error: $stderr, client: nil, environment: ENV)
      new(arguments, input:, output:, error:, client:, environment:).run
    end

    def initialize(arguments, input:, output:, error:, client:, environment:)
      @arguments = arguments.dup
      @input = input
      @output = output
      @error = error
      @client = client
      @environment = environment
      @dry_run = false
      @state_dir = nil
    end

    def run
      parse_options!
      batch = parse_and_validate_batch!
      require_approval!(batch)
      @account_id = account_id_from_environment
      client = @client || Marlens::HarvestApiV2::Client.from_environment(environment: @environment)
      user_id = current_user_id(client)

      store = ReceiptStore.new(receipt_directory, @account_id, user_id)
      result = if @dry_run
                 preflight_result(batch, client, user_id, [store, store.read_only])
               else
                 store.with_lock do |receipts|
                   preflight_result(batch, client, user_id, [store, receipts])
                 end
               end

      emit_result(result)
      successful_result?(result) ? 0 : 1
    rescue InputError => error
      emit_failure(@dry_run ? "preflight" : "submit", error.code)
      1
    rescue ProviderFailure => error
      emit_failure(@dry_run ? "preflight" : "submit", error.code)
      1
    rescue OptionParser::ParseError
      emit_failure(@dry_run ? "preflight" : "submit", "invalid_options")
      1
    rescue StandardError
      emit_failure(@dry_run ? "preflight" : "submit", "submission_failed")
      1
    end

    private

    def parse_options!
      parser = OptionParser.new do |options|
        options.on("--dry-run", "Validate and preflight without receipt changes or writes") { @dry_run = true }
        options.on("--state-dir DIR", "Use a private receipt directory") { |directory| @state_dir = directory }
      end
      parser.parse!(@arguments)
      raise InputError, "invalid_options" unless @arguments.empty?
    end

    def parse_and_validate_batch!
      raw = JSON.parse(@input.read)
      validate_batch!(raw)
    rescue JSON::ParserError
      raise InputError, "invalid_json"
    end

    def validate_batch!(batch)
      require_hash_with_keys!(batch, TOP_LEVEL_KEYS, "invalid_batch_schema")
      raise InputError, "invalid_batch_format" unless batch["format"] == FORMAT && batch["version"].is_a?(Integer) && batch["version"] == 1
      raise InputError, "invalid_approval" unless [true, false].include?(batch["approved"])

      from = valid_date!(batch["from"], "invalid_date_range")
      to = valid_date!(batch["to"], "invalid_date_range")
      raise InputError, "invalid_date_range" if to < from

      policy = batch["policy"]
      require_hash_with_keys!(policy, POLICY_KEYS, "invalid_batch_schema")
      raise InputError, "invalid_policy" unless policy["mode"] == "concurrent-projects"
      grace = policy["responseGraceMinutes"]
      raise InputError, "invalid_policy" unless grace.is_a?(Integer) && grace >= 0

      entries = batch["entries"]
      raise InputError, "invalid_entries" unless entries.is_a?(Array) && !entries.empty?

      seen_ids = {}
      validated_entries = entries.map do |entry|
        validate_entry!(entry, from, to, seen_ids)
      end

      {
        approved: batch["approved"],
        entries: validated_entries
      }
    end

    def validate_entry!(entry, from, to, seen_ids)
      require_entry_keys!(entry)
      spent_date = valid_date!(entry["spentDate"], "invalid_entry_date")
      raise InputError, "entry_date_out_of_range" unless spent_date.between?(from, to)

      local_project = nonblank_string!(entry["localProject"], "invalid_entry_project")
      id = nonblank_string!(entry["id"], "invalid_entry_id")
      expected_id = identity_for(spent_date.iso8601, local_project)
      raise InputError, "invalid_entry_identity" unless id == expected_id
      raise InputError, "duplicate_identity" if seen_ids[id]
      seen_ids[id] = true

      candidate = positive_integer!(entry["candidateMilliseconds"], "invalid_duration")
      milliseconds = positive_integer!(entry["milliseconds"], "invalid_duration")
      adjustment_reason = entry["adjustmentReason"]
      if entry.key?("adjustmentReason") && !adjustment_reason.is_a?(String)
        raise InputError, "invalid_entry_schema"
      end
      if milliseconds > candidate && (!adjustment_reason.is_a?(String) || adjustment_reason.strip.empty?)
        raise InputError, "duration_increase_requires_reason"
      end

      nonnegative_integer!(entry["humanActiveMilliseconds"], "invalid_entry_schema")
      nonnegative_integer!(entry["agentTurnMilliseconds"], "invalid_entry_schema")
      nonnegative_integer!(entry["bridgedGapMilliseconds"], "invalid_entry_schema")
      validate_string_array!(entry["sourceEntryIds"], "invalid_entry_schema", allow_empty: true)
      validate_string_array!(entry["reviewReasons"], "invalid_entry_schema", allow_empty: true)
      raise InputError, "entry_not_reviewed" unless entry["reviewed"] == true

      project = nonblank_string!(entry["project"], "destination_required")
      task = nonblank_string!(entry["task"], "destination_required")
      notes = nonblank_string!(entry["notes"], "reviewed_notes_required")

      {
        id:,
        spent_date: spent_date.iso8601,
        local_project:,
        project:,
        task:,
        milliseconds:,
        notes:
      }
    end

    def require_entry_keys!(entry)
      unless entry.is_a?(Hash) &&
             (entry.keys.sort == REQUIRED_ENTRY_KEYS.sort || entry.keys.sort == ENTRY_KEYS.sort)
        raise InputError, "invalid_entry_schema"
      end
    end

    def require_approval!(batch)
      raise InputError, "batch_not_approved" unless @dry_run || batch[:approved]
    end

    def require_hash_with_keys!(value, keys, code)
      raise InputError, code unless value.is_a?(Hash) && value.keys.sort == keys.sort
    end

    def nonblank_string!(value, code)
      raise InputError, code unless value.is_a?(String) && !value.strip.empty?

      value
    end

    def positive_integer!(value, code)
      raise InputError, code unless value.is_a?(Integer) && value.positive? && value <= MAX_SAFE_INTEGER

      value
    end

    def nonnegative_integer!(value, code)
      raise InputError, code unless value.is_a?(Integer) && value >= 0

      value
    end

    def validate_string_array!(value, code, allow_empty:)
      raise InputError, code unless value.is_a?(Array) && (allow_empty || !value.empty?)
      raise InputError, code unless value.all? { |item| item.is_a?(String) && !item.strip.empty? }
    end

    def valid_date!(value, code)
      raise InputError, code unless value.is_a?(String)

      date = Date.iso8601(value)
      raise InputError, code unless date.iso8601 == value

      date
    rescue Date::Error
      raise InputError, code
    end

    def identity_for(spent_date, local_project)
      digest = Digest::SHA256.hexdigest(JSON.generate(["omp-worklog/v1", spent_date, local_project]))
      "#{ID_PREFIX}#{digest}"
    end

    def account_id_from_environment
      account_id = @environment["HARVEST_ACCOUNT_ID"]
      raise InputError, "account_scope_required" unless account_id.is_a?(String) && !account_id.strip.empty?

      account_id
    end

    def current_user_id(client)
      user = request_object(client, :get, "/v2/users/me")
      id = user["id"]
      raise ProviderFailure, "invalid_current_user" unless valid_provider_id?(id)

      id
    end

    def preflight_result(batch, client, user_id, receipt_context)
      company = request_object(client, :get, "/v2/company")
      timestamp_mode = company["wants_timestamp_timers"]
      raise ProviderFailure, "invalid_company_response" unless [true, false].include?(timestamp_mode)
      raise ProviderFailure, "timestamp_timer_mode_unsupported" if timestamp_mode

      resolved_entries, resolution_results = resolve_entries(client, batch[:entries])
      unless resolved_entries.length == batch[:entries].length
        resolution_results.each do |result|
          result["status"] = "not_submitted" if result["status"] == "ready"
          result["reason"] ||= "batch_preflight_failed" if result["status"] == "not_submitted"
        end
        return build_result(@dry_run ? "preflight" : "submit", "blocked", resolution_results)
      end

      if duplicate_destination?(resolved_entries)
        results = resolved_entries.map do |entry|
          result_with_status(entry_result(entry, "conflict"), "conflict", "duplicate_destination")
        end
        return build_result(@dry_run ? "preflight" : "submit", "blocked", results)
      end

      remote_records = inspect_remote_entries(client, resolved_entries, user_id)
      results = resolved_entries.map do |entry|
        preflight_entry_result(entry, remote_records, receipt_context)
      end

      unless results.all? { |result| %w[ready already_filed].include?(result["status"]) }
        results.each do |result|
          result["status"] = "not_submitted" if result["status"] == "ready"
          result["reason"] ||= "batch_preflight_failed" if result["status"] == "not_submitted"
        end
        status = results.any? { |result| result["status"] == "uncertain" } ? "uncertain" : "blocked"
        return build_result(@dry_run ? "preflight" : "submit", status, results)
      end

      return build_result("preflight", "ready", results) if @dry_run

      store, receipts = receipt_context
      file_ready_entries(resolved_entries, results, store, receipts, client, user_id)
    end

    def request_object(client, method, path, params: {}, body: nil)
      response = client.request(method, path, params:, body:)
      raise ProviderFailure, "invalid_provider_response" unless response.is_a?(Hash)

      response
    rescue ProviderFailure
      raise
    rescue StandardError
      raise ProviderFailure, "provider_request_failed"
    end

    def valid_provider_id?(value)
      (value.is_a?(Integer) && value.positive?) || (value.is_a?(String) && value.match?(/\A[1-9]\d*\z/))
    end

    def resolve_entries(client, entries)
      assignments = personal_assignments(client)
      resolved_entries = []
      results = entries.map do |entry|
        matches = assignments.select do |assignment|
          assignment[:project_name].casecmp?(entry[:project]) && assignment[:task_name].casecmp?(entry[:task])
        end
        if matches.empty?
          result_with_status(entry_result(entry, "blocked"), "blocked", "destination_unmapped")
        elsif matches.length > 1
          result_with_status(entry_result(entry, "blocked"), "blocked", "destination_ambiguous")
        else
          assignment = matches.first
          resolved_entries << entry.merge(project_id: assignment[:project_id], task_id: assignment[:task_id])
          entry_result(entry, "ready")
        end
      end

      [resolved_entries, results]
    end

    def personal_assignments(client)
      assignments = paged_records(client, "/v2/users/me/project_assignments", "project_assignments", is_active: true)
      assignments.filter_map do |project_assignment|
        unless [true, false].include?(project_assignment["is_active"])
          raise ProviderFailure, "invalid_assignment_response"
        end
        next unless project_assignment["is_active"]

        project = project_assignment["project"]
        raise ProviderFailure, "invalid_assignment_response" unless project.is_a?(Hash)
        if project.key?("is_active") && ![true, false].include?(project["is_active"])
          raise ProviderFailure, "invalid_assignment_response"
        end
        next if project["is_active"] == false
        unless valid_provider_id?(project["id"]) && project["name"].is_a?(String) && !project["name"].strip.empty?
          raise ProviderFailure, "invalid_assignment_response"
        end

        task_assignments = project_assignment["task_assignments"]
        raise ProviderFailure, "invalid_assignment_response" unless task_assignments.is_a?(Array)

        task_assignments.filter_map do |task_assignment|
          raise ProviderFailure, "invalid_assignment_response" unless task_assignment.is_a?(Hash)
          unless [true, false].include?(task_assignment["is_active"])
            raise ProviderFailure, "invalid_assignment_response"
          end
          next unless task_assignment["is_active"]

          task = task_assignment["task"]
          raise ProviderFailure, "invalid_assignment_response" unless task.is_a?(Hash)
          unless valid_provider_id?(task["id"]) && task["name"].is_a?(String) && !task["name"].strip.empty?
            raise ProviderFailure, "invalid_assignment_response"
          end

          {
            project_id: project["id"],
            project_name: project["name"],
            task_id: task["id"],
            task_name: task["name"]
          }
        end
      end.flatten
    end

    def paged_records(client, path, collection_key, **params)
      records = []
      page = 1
      seen_pages = {}
      seen_records = {}

      loop do
        raise ProviderFailure, "invalid_pagination" if seen_pages[page]
        seen_pages[page] = true
        response = request_object(client, :get, path, params: params.merge(page:, per_page: PER_PAGE))
        page_records = response[collection_key]
        raise ProviderFailure, "invalid_provider_response" unless page_records.is_a?(Array) && page_records.all? { |record| record.is_a?(Hash) }

        page_records.each do |record|
          signature = Digest::SHA256.hexdigest(JSON.generate(record))
          raise ProviderFailure, "invalid_pagination" if seen_records[signature]

          seen_records[signature] = true
        end
        records.concat(page_records)
        next_page = response["next_page"]
        # If the provider omits next_page, a full page still requires a conservative follow-up request.
        if next_page.nil?
          break if page_records.length < PER_PAGE

          page += 1
          next
        end

        next_page = parse_page_number(next_page)
        raise ProviderFailure, "invalid_pagination" if seen_pages[next_page]

        page = next_page
      end

      records
    end

    def parse_page_number(value)
      page = if value.is_a?(Integer)
               value
             elsif value.is_a?(String) && value.match?(/\A[1-9]\d*\z/)
               value.to_i
             end
      raise ProviderFailure, "invalid_pagination" unless page && page.positive?

      page
    end

    def duplicate_destination?(entries)
      destinations = entries.map { |entry| [entry[:spent_date], id_string(entry[:project_id]), id_string(entry[:task_id])] }
      destinations.uniq.length != destinations.length
    end

    def inspect_remote_entries(client, entries, user_id)
      by_reference = {}
      entries.each do |entry|
        matches = paged_records(
          client,
          "/v2/time_entries",
          "time_entries",
          user_id:, external_reference_id: entry[:id], from: entry[:spent_date], to: entry[:spent_date]
        )
        matches = current_user_records(matches, user_id)
        validate_time_entry_records!(matches)
        matches.each do |record|
          raise ProviderFailure, "invalid_provider_response" unless record.dig("external_reference", "id") == entry[:id]
        end
        by_reference[entry[:id]] = matches
      end

      by_date = {}
      entries.map { |entry| entry[:spent_date] }.uniq.each do |spent_date|
        records = paged_records(
          client,
          "/v2/time_entries",
          "time_entries",
          user_id:, from: spent_date, to: spent_date
        )
        records = current_user_records(records, user_id)
        validate_time_entry_records!(records)
        by_date[spent_date] = records
      end

      { by_reference:, by_date: }
    end

    def current_user_records(records, user_id)
      records.filter_map do |record|
        record_user_id = record["user"].is_a?(Hash) ? record["user"]["id"] : nil
        unless valid_provider_id?(record_user_id)
          raise ProviderFailure, "invalid_provider_response"
        end
        if id_string(record_user_id) != id_string(user_id)
          next
        end

        record
      end
    end

    def validate_time_entry_records!(records)
      records.each do |record|
        unless valid_provider_id?(record["id"]) && record["project"].is_a?(Hash) &&
            valid_provider_id?(record["project"]["id"]) && record["task"].is_a?(Hash) &&
            valid_provider_id?(record["task"]["id"]) && record["spent_date"].is_a?(String)
          raise ProviderFailure, "invalid_provider_response"
        end

        begin
          date = Date.iso8601(record["spent_date"])
        rescue Date::Error
          raise ProviderFailure, "invalid_provider_response"
        end
        raise ProviderFailure, "invalid_provider_response" unless date.iso8601 == record["spent_date"]
        raise ProviderFailure, "invalid_provider_response" unless record["hours"].nil? || record["hours"].is_a?(Numeric)
        raise ProviderFailure, "invalid_provider_response" unless record["notes"].nil? || record["notes"].is_a?(String)

        reference = record["external_reference"]
        if !reference.nil? && (!reference.is_a?(Hash) || !reference["id"].is_a?(String) || reference["id"].empty?)
          raise ProviderFailure, "invalid_provider_response"
        end
      end
    end

    def preflight_entry_result(entry, remote_records, receipt_context)
      result = entry_result(entry, "ready")
      matching_records = remote_records[:by_reference].fetch(entry[:id])
      if matching_records.any?
        if matching_records.length != 1
          return result_with_status(result, "conflict", "duplicate_external_reference")
        end

        record = matching_records.first
        return result_with_status(result, "already_filed", nil, record["id"]) if exact_remote_match?(entry, record)

        return result_with_status(result, "conflict", "external_reference_content_conflict")
      end

      destination_records = remote_records[:by_date].fetch(entry[:spent_date]).select do |record|
        id_string(record.dig("project", "id")) == id_string(entry[:project_id]) &&
          id_string(record.dig("task", "id")) == id_string(entry[:task_id])
      end
      if destination_records.any?
        reason = destination_records.any? { |record| record["is_locked"] == true || record["is_running"] == true } ?
          "locked_or_running_entry" : "existing_entry"
        return result_with_status(result, "blocked", reason)
      end

      receipt = if receipt_context
                  receipt_context.last[entry[:id]]
                end
      if receipt && %w[pending uncertain submitted].include?(receipt["status"])
        unless receipt["fingerprint"] == fingerprint(entry)
          return result_with_status(result, "conflict", "receipt_content_conflict")
        end

        return result_with_status(result, "uncertain", "remote_entry_not_found")
      end

      result
    end

    def exact_remote_match?(entry, record)
      valid_provider_id?(record["id"]) &&
        record["spent_date"] == entry[:spent_date] &&
        id_string(record.dig("project", "id")) == id_string(entry[:project_id]) &&
        id_string(record.dig("task", "id")) == id_string(entry[:task_id]) &&
        numeric_hours?(record["hours"], entry[:milliseconds]) &&
        record["notes"] == entry[:notes] && record["is_running"] == false
    end

    def numeric_hours?(hours, milliseconds)
      hours.is_a?(Numeric) && hours == milliseconds / 3_600_000.0
    end

    def id_string(value)
      value.nil? ? "" : value.to_s
    end

    def fingerprint(entry)
      canonical = [
        entry[:id], entry[:spent_date], entry[:project_id], entry[:task_id],
        entry[:milliseconds], entry[:notes]
      ]
      Digest::SHA256.hexdigest(JSON.generate(canonical))
    end

    def entry_result(entry, status)
      {
        "id" => entry[:id],
        "spentDate" => entry[:spent_date],
        "localProject" => entry[:local_project],
        "status" => status
      }
    end

    def result_with_status(result, status, reason, harvest_entry_id = nil)
      result["status"] = status
      result["reason"] = reason if reason
      result["harvestEntryId"] = harvest_entry_id if harvest_entry_id
      result
    end

    def file_ready_entries(entries, results, store, receipts, client, user_id)
      entries.each_with_index do |entry, index|
        if results[index]["status"] == "already_filed"
          receipts[entry[:id]] = receipt_for(entry, "submitted", results[index]["harvestEntryId"])
        end
      end
      store.save!(receipts) if results.any? { |result| result["status"] == "already_filed" }

      entries.each_with_index do |entry, index|
        next unless results[index]["status"] == "ready"

        receipts[entry[:id]] = receipt_for(entry, "pending")
        store.save!(receipts)
        begin
          response = client.request(
            :post,
            "/v2/time_entries",
            body: {
              user_id:,
              project_id: entry[:project_id],
              task_id: entry[:task_id],
              spent_date: entry[:spent_date],
              hours: entry[:milliseconds] / 3_600_000.0,
              notes: entry[:notes],
              external_reference: { id: entry[:id] }
            }
          )
          harvest_entry_id = response.is_a?(Hash) ? response["id"] : nil
          unless valid_provider_id?(harvest_entry_id)
            receipts[entry[:id]] = receipt_for(entry, "uncertain")
            store.save!(receipts)
            result_with_status(results[index], "uncertain", "invalid_create_response")
            mark_not_submitted(results, index + 1)
            return build_result("submit", "uncertain", results)
          end

          receipts[entry[:id]] = receipt_for(entry, "submitted", harvest_entry_id)
          store.save!(receipts)
          result_with_status(results[index], "created", nil, harvest_entry_id)
        rescue Marlens::HarvestApiV2::Error => error
          if %w[400 401 403 404 422 429].include?(error.status.to_s)
            receipts[entry[:id]] = receipt_for(entry, "rejected")
            store.save!(receipts)
            result_with_status(results[index], "blocked", "provider_rejected")
          else
            receipts[entry[:id]] = receipt_for(entry, "uncertain")
            store.save!(receipts)
            result_with_status(results[index], "uncertain", "create_outcome_unknown")
          end
          mark_not_submitted(results, index + 1)
          return submission_result(results)
        rescue StandardError
          receipts[entry[:id]] = receipt_for(entry, "uncertain")
          begin
            store.save!(receipts)
          rescue StandardError
            # The pending receipt was durable before the request.
          end
          result_with_status(results[index], "uncertain", "create_outcome_unknown")
          mark_not_submitted(results, index + 1)
          return build_result("submit", "uncertain", results)
        end
      end

      build_result("submit", "complete", results)
    end

    def receipt_for(entry, status, harvest_entry_id = nil)
      receipt = { "fingerprint" => fingerprint(entry), "status" => status }
      receipt["harvestEntryId"] = harvest_entry_id if harvest_entry_id
      receipt
    end

    def mark_not_submitted(results, start_index)
      results.each_with_index do |result, index|
        next if index < start_index || result["status"] != "ready"

        result["status"] = "not_submitted"
        result["reason"] = "earlier_create_failed"
      end
    end

    def submission_result(results)
      return build_result("submit", "uncertain", results) if results.any? { |result| result["status"] == "uncertain" }

      succeeded = results.any? { |result| %w[created already_filed].include?(result["status"]) }
      build_result("submit", succeeded ? "partial" : "blocked", results)
    end

    def build_result(mode, status, results)
      {
        "format" => RESULT_FORMAT,
        "version" => 1,
        "mode" => mode,
        "status" => status,
        "results" => results
      }
    end

    def successful_result?(result)
      %w[ready complete].include?(result["status"])
    end

    def emit_result(result)
      @output.puts JSON.generate(result)
    end

    def emit_failure(mode, reason)
      @error.puts "Error: #{reason}"
      emit_result(build_result(mode, "blocked", []).merge("reason" => reason))
    end

    def receipt_directory
      @state_dir || File.join(Dir.home, ".omp", "worklog", "submissions")
    end

    class ReceiptStore
      def initialize(directory, account_id, user_id)
        @directory = directory
        @scope = Digest::SHA256.hexdigest(JSON.generate([account_id, user_id]))
        @receipt_path = File.join(directory, "#{@scope}.json")
        @lock_path = File.join(directory, "#{@scope}.lock")
      end

      def read_only
        return {} unless File.exist?(@directory)
        raise ProviderFailure, "unsafe_receipt_directory" if File.lstat(@directory).symlink?

        load_receipts
      end

      def with_lock
        FileUtils.mkdir_p(@directory, mode: 0o700)
        raise ProviderFailure, "unsafe_receipt_directory" if File.lstat(@directory).symlink?

        File.chmod(0o700, @directory)
        File.open(@lock_path, File::RDWR | File::CREAT | File::NOFOLLOW, 0o600) do |lock|
          begin
            raise ProviderFailure, "unsafe_receipt_lock" unless lock.stat.file?

            File.chmod(0o600, @lock_path)
            File.chmod(0o600, @receipt_path) if File.exist?(@receipt_path) && !File.lstat(@receipt_path).symlink?
            lock.flock(File::LOCK_EX)
            yield load_receipts
          ensure
            lock.flock(File::LOCK_UN)
          end
        end
      rescue ProviderFailure
        raise
      rescue StandardError
        raise ProviderFailure, "receipt_storage_failed"
      end

      def save!(receipts)
        Tempfile.create([".receipt-", ".tmp"], @directory, mode: 0o600) do |temporary|
          temporary.chmod(0o600)
          temporary.write(JSON.generate({ "format" => RECEIPT_FORMAT, "version" => 1, "entries" => receipts }))
          temporary.flush
          temporary.fsync
          File.rename(temporary.path, @receipt_path)
          File.open(@directory, File::RDONLY) { |directory| directory.fsync }
        end
      rescue StandardError
        raise ProviderFailure, "receipt_storage_failed"
      end

      private

      def load_receipts
        return {} unless File.exist?(@receipt_path)

        raise ProviderFailure, "unsafe_receipt_file" if File.lstat(@receipt_path).symlink?
        document = File.open(@receipt_path, File::RDONLY | File::NOFOLLOW, &:read)
        data = JSON.parse(document)
        unless data.is_a?(Hash) && data["format"] == RECEIPT_FORMAT && data["version"] == 1 && data["entries"].is_a?(Hash)
          raise ProviderFailure, "invalid_receipt_state"
        end

        data["entries"].each_value do |receipt|
          unless receipt.is_a?(Hash) && %w[pending uncertain submitted rejected].include?(receipt["status"]) &&
              receipt["fingerprint"].is_a?(String)
            raise ProviderFailure, "invalid_receipt_state"
          end
        end
        data["entries"]
      rescue JSON::ParserError
        raise ProviderFailure, "invalid_receipt_state"
      end
    end
  end
end
