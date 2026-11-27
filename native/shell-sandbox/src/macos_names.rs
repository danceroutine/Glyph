//! A running Seatbelt profile must also cover future reservations on folding APFS volumes.
use super::{macos::seatbelt_string, SandboxRequest};
use std::{ffi::CStr, io, mem::MaybeUninit, os::unix::ffi::OsStrExt, path::PathBuf};

struct Volume {
    path: PathBuf,
    folds: bool,
}

fn count(result: i32) -> io::Result<usize> {
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(result as usize)
    }
}

fn complete(used: usize, capacity: usize) -> io::Result<usize> {
    if used >= capacity {
        Err(io::Error::other(
            "Mounts changed while preparing the sandbox. Retry the command.",
        ))
    } else {
        Ok(used)
    }
}

fn volumes() -> io::Result<Vec<Volume>> {
    // getfsstat fills caller-owned storage. Request extra capacity in case a disk is mounted in flight.
    let initial = count(unsafe { libc::getfsstat(std::ptr::null_mut(), 0, libc::MNT_NOWAIT) })?;
    let mut entries = vec![MaybeUninit::<libc::statfs>::uninit(); initial + 8];
    let capacity = std::mem::size_of_val(entries.as_slice()) as i32;
    let used =
        count(unsafe { libc::getfsstat(entries.as_mut_ptr().cast(), capacity, libc::MNT_NOWAIT) })?;
    let used = complete(used, entries.len())?;
    Ok(entries[..used]
        .iter()
        .map(|entry| {
            // getfsstat initialized this entry and both mount names are NUL-terminated kernel fields.
            let entry = unsafe { entry.assume_init_ref() };
            let mount = unsafe { CStr::from_ptr(entry.f_mntonname.as_ptr()) };
            let kind = unsafe { CStr::from_ptr(entry.f_fstypename.as_ptr()) };
            let folds = kind.to_bytes() == b"apfs"
                && unsafe { libc::pathconf(mount.as_ptr(), libc::_PC_CASE_SENSITIVE) } != 1;
            Volume {
                path: PathBuf::from(std::ffi::OsStr::from_bytes(mount.to_bytes())),
                folds,
            }
        })
        .collect())
}

fn regions(volumes: &[Volume]) -> String {
    let mut result = Vec::new();
    for volume in volumes.iter().filter(|volume| volume.folds) {
        let mut predicates = vec![format!("(subpath {})", seatbelt_string(&volume.path))];
        for other in volumes
            .iter()
            .filter(|other| !other.folds && other.path.starts_with(&volume.path))
        {
            predicates.push(format!(
                "(require-not (subpath {}))",
                seatbelt_string(&other.path)
            ));
        }
        result.push(format!("(require-all {})", predicates.join(" ")));
    }
    format!("(require-any {})", result.join(" "))
}

pub(super) fn extend(policy: &mut String, request: &SandboxRequest) -> io::Result<()> {
    extend_for(policy, request, &volumes()?);
    Ok(())
}

fn extend_for(policy: &mut String, request: &SandboxRequest, volumes: &[Volume]) {
    if !volumes.iter().any(|volume| volume.folds) {
        return;
    }
    let region = regions(volumes);
    // Unicode decomposition and full case folding add exactly these scalars to the ASCII
    // components below: long s, Kelvin sign and the two st ligatures. Seatbelt regexes operate
    // on UTF-8 bytes, so put each multibyte spelling in an alternative outside character classes.
    let s = "([sS]|ſ)";
    let k = "([kK]|K)";
    let st = format!("({s}[tT]|ﬅ|ﬆ)");
    let skill = format!("{s}{k}[iI][lL][lL]");
    let staging = format!(r#"(regex #"/\.{skill}-{st}[aA][gG][iI][nN][gG](/|$)")"#);
    let run = format!(r#"(regex #"/\.[gG][lL][yY][pP][hH]-{skill}-[rR][uU][nN](/|$)")"#);
    let managed = format!(
        r#"(regex #"/\.([gG][lL][yY][pP][hH]|[cC][uU][rR]{s}[oO][rR])(/{skill}{s}(/|$)|$)")"#
    );
    policy.push_str(&format!(
        "(deny file-read* file-write* file-test-existence (require-all {region} {staging}))\n"
    ));
    policy.push_str(&format!(
        "(deny file-write* (require-all {region} (require-any {run} {managed})))\n"
    ));
    let mut readable = vec![region, run];
    for resource in request
        .read_only_paths
        .iter()
        .filter(|path| super::execution_root(path))
    {
        readable.push(format!(
            "(require-not (subpath {}))",
            seatbelt_string(resource)
        ));
    }
    policy.push_str(&format!(
        "(deny file-read* file-test-existence (require-all {}))\n",
        readable.join(" ")
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    #[test]
    fn limits_folding_predicates_to_the_matching_volume_and_keeps_admitted_resources_readable() {
        let listed = vec![
            Volume {
                path: "/".into(),
                folds: true,
            },
            Volume {
                path: "/sensitive".into(),
                folds: false,
            },
            Volume {
                path: "/sensitive/folded".into(),
                folds: true,
            },
        ];
        let mut request = crate::tests::request(
            crate::SandboxProfile::ReadOnly,
            Path::new("/project"),
            Path::new("/state"),
        );
        request
            .read_only_paths
            .push("/tmp/safe/.glyph-skill-run".into());
        let mut policy = String::new();
        extend_for(&mut policy, &request, &[]);
        assert!(policy.is_empty());
        extend_for(&mut policy, &request, &listed);
        assert!(policy.contains("(require-not (subpath \"/sensitive\"))"));
        assert!(policy.contains("(subpath \"/sensitive/folded\")"));
        assert!(policy.contains("(require-not (subpath \"/tmp/safe/.glyph-skill-run\"))"));
        assert!(count(-1).is_err());
        assert!(complete(3, 3).is_err());
    }
}
