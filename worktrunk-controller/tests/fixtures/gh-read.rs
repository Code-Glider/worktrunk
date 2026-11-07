fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let fields: Vec<_> = args.iter().map(String::as_str).collect();
    let response = match fields.as_slice() {
        ["api", "--hostname", "github.com", "--method", "GET", "repos/owner/repo"] => "repo.json",
        ["api", "--hostname", "github.com", "--method", "GET", "repos/owner/repo/issues/7"] => {
            "issue.json"
        }
        ["api", "--hostname", "github.com", "--method", "GET", "repos/owner/repo/issues/7/timeline?per_page=100", "--paginate", "--slurp"] => {
            "timeline.json"
        }
        _ => panic!("Unexpected GitHub read: {args:?}"),
    };
    let executable = std::env::current_exe().unwrap();
    let response = std::fs::read_to_string(executable.with_file_name(response)).unwrap();
    print!("{response}");
}
