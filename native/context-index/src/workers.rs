use std::io;
use std::thread::{self, JoinHandle};

/// Infrastructure roles retain their existing OS thread names and spawn policy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WorkerRole {
    ProtocolWriter,
    Service,
    ContentSearch,
    FilesystemMonitor,
}

/// Acquires a real, joinable worker. Task execution and failure remain owned by
/// the caller; the factory does not catch panics, retry, or change scheduling.
pub(crate) trait WorkerFactory: Clone + Send + Sync + 'static {
    fn spawn<T: Send + 'static>(
        &self,
        role: WorkerRole,
        task: impl FnOnce() -> T + Send + 'static,
    ) -> io::Result<JoinHandle<T>>;
}

#[derive(Clone, Copy)]
pub(crate) struct SystemWorkers;

impl WorkerFactory for SystemWorkers {
    fn spawn<T: Send + 'static>(
        &self,
        role: WorkerRole,
        task: impl FnOnce() -> T + Send + 'static,
    ) -> io::Result<JoinHandle<T>> {
        let builder = thread::Builder::new();
        let builder = match role {
            WorkerRole::ProtocolWriter => builder.name("context-index-protocol-writer".into()),
            WorkerRole::Service => builder.name("context-index-service".into()),
            WorkerRole::FilesystemMonitor => builder.name("context-index-monitor".into()),
            WorkerRole::ContentSearch => builder,
        };
        builder.spawn(task)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_workers_preserve_names_and_return_joinable_task_results() {
        for (role, name) in [
            (
                WorkerRole::ProtocolWriter,
                Some("context-index-protocol-writer"),
            ),
            (WorkerRole::Service, Some("context-index-service")),
            (WorkerRole::FilesystemMonitor, Some("context-index-monitor")),
            (WorkerRole::ContentSearch, None),
        ] {
            let worker = SystemWorkers
                .spawn(role, || (thread::current().name().map(str::to_owned), 42))
                .unwrap();
            assert_eq!(worker.join().unwrap(), (name.map(str::to_owned), 42));
        }
    }
}
