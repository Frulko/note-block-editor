import { mount } from 'svelte';
import App from './App.svelte';
import '@nbe/dom/style.css';
import './demo.css';

mount(App, { target: document.getElementById('app')! });
