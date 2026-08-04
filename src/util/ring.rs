//! A fixed-capacity circular buffer for time-series samples. Overwrites the
//! oldest entries when full. Cheap O(1) push and O(n) snapshot with support
//! for range queries and stride-based downsampling for chart transfer.

/// A generic ring buffer over `T: Clone`.
#[derive(Debug, Clone)]
pub struct RingBuffer<T: Clone> {
    buffer: Vec<Option<T>>,
    capacity: usize,
    head: usize,
    size: usize,
}

impl<T: Clone> RingBuffer<T> {
    /// Create a ring buffer holding at most `capacity` items (min 1).
    pub fn new(capacity: usize) -> Self {
        let capacity = capacity.max(1);
        RingBuffer {
            buffer: vec![None; capacity],
            capacity,
            head: 0,
            size: 0,
        }
    }

    /// Push a new item, evicting the oldest when full.
    pub fn push(&mut self, item: T) {
        self.buffer[self.head] = Some(item);
        self.head = (self.head + 1) % self.capacity;
        if self.size < self.capacity {
            self.size += 1;
        }
    }

    /// Current number of stored items.
    pub fn len(&self) -> usize {
        self.size
    }

    /// Whether the buffer holds no items.
    pub fn is_empty(&self) -> bool {
        self.size == 0
    }

    /// Whether the buffer is at capacity.
    pub fn is_full(&self) -> bool {
        self.size == self.capacity
    }

    /// The configured capacity.
    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// The most recently pushed item, if any.
    pub fn last(&self) -> Option<&T> {
        if self.size == 0 {
            return None;
        }
        let idx = (self.head + self.capacity - 1) % self.capacity;
        self.buffer[idx].as_ref()
    }

    /// The oldest retained item, if any.
    pub fn first(&self) -> Option<&T> {
        if self.size == 0 {
            return None;
        }
        let idx = (self.head + self.capacity - self.size) % self.capacity;
        self.buffer[idx].as_ref()
    }

    /// Collect all items in chronological order into a Vec.
    pub fn to_vec(&self) -> Vec<T> {
        let mut out = Vec::with_capacity(self.size);
        let start = (self.head + self.capacity - self.size) % self.capacity;
        for i in 0..self.size {
            let idx = (start + i) % self.capacity;
            if let Some(item) = &self.buffer[idx] {
                out.push(item.clone());
            }
        }
        out
    }

    /// Return the last `n` items in chronological order.
    pub fn last_n(&self, n: usize) -> Vec<T> {
        let n = n.min(self.size);
        let mut out = Vec::with_capacity(n);
        let start = (self.head + self.capacity - n) % self.capacity;
        for i in 0..n {
            let idx = (start + i) % self.capacity;
            if let Some(item) = &self.buffer[idx] {
                out.push(item.clone());
            }
        }
        out
    }

    /// Downsample to at most `max_points` items using stride decimation,
    /// always preserving the final (most recent) item.
    pub fn downsample(&self, max_points: usize) -> Vec<T> {
        let all = self.to_vec();
        if all.len() <= max_points || max_points == 0 {
            return all;
        }
        if max_points == 1 {
            return vec![all[all.len() - 1].clone()];
        }
        let last_idx = all.len() - 1;
        let stride = last_idx.div_ceil(max_points - 1);
        let mut out: Vec<T> = Vec::with_capacity(max_points);
        let mut i = 0;
        while i < last_idx && out.len() < max_points - 1 {
            out.push(all[i].clone());
            i += stride;
        }
        // Ensure the newest sample is present for an accurate right edge.
        out.push(all[last_idx].clone());
        out
    }

    /// Clear all items.
    pub fn clear(&mut self) {
        for slot in self.buffer.iter_mut() {
            *slot = None;
        }
        self.head = 0;
        self.size = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_push_and_overflow() {
        let mut rb: RingBuffer<i32> = RingBuffer::new(3);
        rb.push(1);
        rb.push(2);
        rb.push(3);
        rb.push(4);
        assert_eq!(rb.to_vec(), vec![2, 3, 4]);
        assert_eq!(rb.len(), 3);
        assert!(rb.is_full());
    }

    #[test]
    fn test_first_last() {
        let mut rb: RingBuffer<i32> = RingBuffer::new(4);
        rb.push(10);
        rb.push(20);
        rb.push(30);
        assert_eq!(rb.first(), Some(&10));
        assert_eq!(rb.last(), Some(&30));
    }

    #[test]
    fn test_last_n() {
        let mut rb: RingBuffer<i32> = RingBuffer::new(10);
        for i in 0..6 {
            rb.push(i);
        }
        assert_eq!(rb.last_n(3), vec![3, 4, 5]);
    }

    #[test]
    fn test_downsample_keeps_last() {
        let mut rb: RingBuffer<i32> = RingBuffer::new(100);
        for i in 0..100 {
            rb.push(i);
        }
        let ds = rb.downsample(10);
        assert!(ds.len() <= 10);
        assert_eq!(ds.last(), Some(&99));
    }

    #[test]
    fn test_downsample_one_returns_latest() {
        let mut rb: RingBuffer<i32> = RingBuffer::new(3);
        rb.push(1);
        rb.push(2);
        rb.push(3);
        assert_eq!(rb.downsample(1), vec![3]);
    }

    #[test]
    fn test_empty() {
        let rb: RingBuffer<i32> = RingBuffer::new(5);
        assert!(rb.is_empty());
        assert_eq!(rb.last(), None);
        assert_eq!(rb.to_vec(), Vec::<i32>::new());
    }
}
