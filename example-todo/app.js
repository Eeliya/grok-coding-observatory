// Todo App
let todos = [];
let filter = 'all';

const todoInput = document.getElementById('todoInput');
const addBtn = document.getElementById('addBtn');
const todoList = document.getElementById('todoList');
const count = document.getElementById('count');
const clearCompleted = document.getElementById('clearCompleted');
const filters = document.querySelectorAll('.filter');

// Load todos from localStorage
function loadTodos() {
  const saved = localStorage.getItem('todos');
  if (saved) {
    todos = JSON.parse(saved);
    render();
  }
}

// Save todos to localStorage
function saveTodos() {
  localStorage.setItem('todos', JSON.stringify(todos));
}

// Add new todo
function addTodo() {
  const text = todoInput.value.trim();
  if (!text) return;
  
  const todo = {
    id: Date.now(),
    text: text,
    completed: false
  };
  
  todos.push(todo);
  todoInput.value = '';
  saveTodos();
  render();
}

// Toggle todo completion
function toggleTodo(id) {
  const todo = todos.find(t => t.id === id);
  if (todo) {
    todo.completed = !todo.completed;
    saveTodos();
    render();
  }
}

// Delete todo
function deleteTodo(id) {
  todos = todos.filter(t => t.id !== id);
  saveTodos();
  render();
}

// Clear completed todos
function clearCompletedTodos() {
  todos = todos.filter(t => !t.completed);
  saveTodos();
  render();
}

// Get filtered todos
function getFilteredTodos() {
  if (filter === 'active') {
    return todos.filter(t => !t.completed);
  } else if (filter === 'completed') {
    return todos.filter(t => t.completed);
  }
  return todos;
}

// Render todos
function render() {
  const filtered = getFilteredTodos();
  
  if (filtered.length === 0) {
    todoList.innerHTML = '<div class="empty-state">No todos yet. Add one above! ✨</div>';
  } else {
    todoList.innerHTML = filtered.map(todo => `
      <li class="todo-item ${todo.completed ? 'completed' : ''}" data-id="${todo.id}">
        <div class="todo-checkbox ${todo.completed ? 'checked' : ''}" onclick="toggleTodo(${todo.id})"></div>
        <span class="todo-text">${todo.text}</span>
        <button class="delete-btn" onclick="deleteTodo(${todo.id})">×</button>
      </li>
    `).join('');
  }
  
  // Update count
  const activeCount = todos.filter(t => !t.completed).length;
  count.textContent = `${activeCount} ${activeCount === 1 ? 'item' : 'items'} left`;
}

// Event listeners
addBtn.addEventListener('click', addTodo);
todoInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') addTodo();
});

clearCompleted.addEventListener('click', clearCompletedTodos);

filters.forEach(btn => {
  btn.addEventListener('click', () => {
    filters.forEach(f => f.classList.remove('active'));
    btn.classList.add('active');
    filter = btn.dataset.filter;
    render();
  });
});

// Initialize
loadTodos();
