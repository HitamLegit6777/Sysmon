//! Metric collectors. Each collector reads a specific subsystem from `/proc`
//! or `/sys` and returns a serializable metrics struct. Collectors that need
//! rate calculations retain the minimal previous-sample state required.

pub mod cpu;
pub mod disk;
pub mod host;
pub mod load;
pub mod memory;
pub mod network;
pub mod process;
pub mod thermal;

pub use cpu::CpuCollector;
pub use disk::DiskCollector;
pub use host::HostCollector;
pub use load::LoadCollector;
pub use memory::MemoryCollector;
pub use network::NetworkCollector;
pub use process::ProcessCollector;
pub use thermal::ThermalCollector;
